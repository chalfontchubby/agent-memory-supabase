-- Hybrid search (Postgres full-text + pgvector, fused with RRF) and related-memory lookup.
-- Everything here is SECURITY INVOKER: it runs as the member, so RLS filters every row.

-- Member queries use extensions.vector and its operators.
grant usage on schema extensions to agent_memory_member;

create function agent_memory.member_name(p_id uuid) returns text
language sql stable security definer set search_path = ''
as $$ select m.display_name from agent_memory.members m where m.id = p_id $$;

revoke execute on function agent_memory.member_name(uuid) from public;
grant execute on function agent_memory.member_name(uuid) to agent_memory_member;

create view agent_memory.memory_view with (security_invoker = true) as
select
  m.id,
  m.scope_id,
  s.name as scope,
  m.content,
  m.category,
  m.tags,
  m.created_at,
  m.updated_at,
  agent_memory.member_name(m.created_by) as created_by,
  agent_memory.member_name(m.updated_by) as updated_by,
  m.access_count,
  m.last_accessed_at
from agent_memory.memories m
join agent_memory.scopes s on s.id = m.scope_id;

grant select on agent_memory.memory_view to agent_memory_member;

-- Contract: returns at most p_limit rows in every mode (each hybrid arm fetches p_limit, fused result is
-- trimmed to p_limit); callers over-fetch for decay re-ranking.
-- Exact similarity on purpose: an ANN index post-filtered by RLS returns short pages and leaks result counts;
-- exact scan is milliseconds at this size.
create function agent_memory.search_memories(
  p_query text,
  p_embedding extensions.vector(384),
  p_mode text,
  p_scope_ids uuid[],
  p_category text,
  p_tags text[],
  p_after timestamptz,
  p_before timestamptz,
  p_limit int
) returns table (
  id uuid, scope_id uuid, scope text, content text, category text, tags text[],
  created_at timestamptz, updated_at timestamptz, created_by text, updated_by text,
  access_count int, last_accessed_at timestamptz, raw_score float8
)
language plpgsql stable security invoker
set search_path = ''
set client_min_messages = warning -- websearch_to_tsquery NOTICEs on stop-word-only queries
as $$
#variable_conflict use_column
declare
  v_tsq tsquery;
begin
  if p_mode is null or p_mode not in ('keyword', 'semantic', 'hybrid') then
    raise exception 'invalid search mode: %', p_mode using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'invalid limit: %', p_limit using errcode = '22023';
  end if;
  if p_mode <> 'keyword' and p_embedding is null then
    raise exception 'embedding required for % search', p_mode using errcode = '22023';
  end if;
  v_tsq := pg_catalog.websearch_to_tsquery('english', coalesce(p_query, ''));

  if p_mode = 'keyword' then
    if pg_catalog.numnode(v_tsq) = 0 then
      return;
    end if;
    return query
    select v.id, v.scope_id, v.scope, v.content, v.category, v.tags, v.created_at, v.updated_at,
           v.created_by, v.updated_by, v.access_count, v.last_accessed_at, k.score
    from (
      select m.id, pg_catalog.ts_rank_cd(m.fts, v_tsq)::float8 as score
      from agent_memory.memories m
      where m.fts operator(pg_catalog.@@) v_tsq
        and (p_scope_ids is null or m.scope_id = any (p_scope_ids))
        and (p_category is null or m.category = p_category)
        and (p_tags is null or m.tags && p_tags)
        and (p_after is null or m.created_at >= p_after)
        and (p_before is null or m.created_at <= p_before)
      order by score desc, m.id
      limit p_limit
    ) k
    join agent_memory.memory_view v on v.id = k.id
    order by k.score desc, v.id;

  elsif p_mode = 'semantic' then
    return query
    select v.id, v.scope_id, v.scope, v.content, v.category, v.tags, v.created_at, v.updated_at,
           v.created_by, v.updated_by, v.access_count, v.last_accessed_at, (1 / (1 + s.dist))::float8
    from (
      select m.id, (m.embedding operator(extensions.<=>) p_embedding) as dist
      from agent_memory.memories m
      where (p_scope_ids is null or m.scope_id = any (p_scope_ids))
        and (p_category is null or m.category = p_category)
        and (p_tags is null or m.tags && p_tags)
        and (p_after is null or m.created_at >= p_after)
        and (p_before is null or m.created_at <= p_before)
      order by m.embedding operator(extensions.<=>) p_embedding, m.id
      limit p_limit
    ) s
    join agent_memory.memory_view v on v.id = s.id
    order by s.dist, v.id;

  else
    return query
    with kw as (
      select m.id, pg_catalog.row_number() over (order by pg_catalog.ts_rank_cd(m.fts, v_tsq) desc, m.id) as rnk
      from agent_memory.memories m
      where pg_catalog.numnode(v_tsq) > 0 and m.fts operator(pg_catalog.@@) v_tsq
        and (p_scope_ids is null or m.scope_id = any (p_scope_ids))
        and (p_category is null or m.category = p_category)
        and (p_tags is null or m.tags && p_tags)
        and (p_after is null or m.created_at >= p_after)
        and (p_before is null or m.created_at <= p_before)
      order by pg_catalog.ts_rank_cd(m.fts, v_tsq) desc, m.id
      limit p_limit
    ),
    sem as (
      select m.id, pg_catalog.row_number() over (order by m.embedding operator(extensions.<=>) p_embedding, m.id) as rnk
      from agent_memory.memories m
      where (p_scope_ids is null or m.scope_id = any (p_scope_ids))
        and (p_category is null or m.category = p_category)
        and (p_tags is null or m.tags && p_tags)
        and (p_after is null or m.created_at >= p_after)
        and (p_before is null or m.created_at <= p_before)
      order by m.embedding operator(extensions.<=>) p_embedding, m.id
      limit p_limit
    ),
    fused as (
      select coalesce(kw.id, sem.id) as id,
             (coalesce(1.0 / (60 + kw.rnk), 0) + coalesce(1.0 / (60 + sem.rnk), 0))::float8 as score
      from kw full outer join sem on kw.id = sem.id
    )
    select v.id, v.scope_id, v.scope, v.content, v.category, v.tags, v.created_at, v.updated_at,
           v.created_by, v.updated_by, v.access_count, v.last_accessed_at, f.score
    from fused f
    join agent_memory.memory_view v on v.id = f.id
    order by f.score desc, v.id
    limit p_limit;
  end if;
end
$$;

create function agent_memory.related_memories(p_id uuid, p_scope_ids uuid[], p_limit int)
returns table (
  id uuid, scope_id uuid, scope text, content text, category text, tags text[],
  created_at timestamptz, updated_at timestamptz, created_by text, updated_by text,
  access_count int, last_accessed_at timestamptz, raw_score float8
)
language plpgsql stable security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_emb extensions.vector(384);
begin
  -- RLS: an unreadable (or deleted, or absent) id yields no embedding and therefore no rows.
  select m.embedding into v_emb from agent_memory.memories m where m.id = p_id;
  if v_emb is null then
    return;
  end if;
  return query
  select v.id, v.scope_id, v.scope, v.content, v.category, v.tags, v.created_at, v.updated_at,
         v.created_by, v.updated_by, v.access_count, v.last_accessed_at, (1 / (1 + s.dist))::float8
  from (
    select m.id, (m.embedding operator(extensions.<=>) v_emb) as dist
    from agent_memory.memories m
    where m.id <> p_id
      and (p_scope_ids is null or m.scope_id = any (p_scope_ids))
    order by m.embedding operator(extensions.<=>) v_emb, m.id
    limit p_limit
  ) s
  join agent_memory.memory_view v on v.id = s.id
  order by s.dist, v.id;
end
$$;

revoke execute on function agent_memory.search_memories(text, extensions.vector, text, uuid[], text, text[], timestamptz, timestamptz, int) from public;
revoke execute on function agent_memory.related_memories(uuid, uuid[], int) from public;
grant execute on function agent_memory.search_memories(text, extensions.vector, text, uuid[], text, text[], timestamptz, timestamptz, int) to agent_memory_member;
grant execute on function agent_memory.related_memories(uuid, uuid[], int) to agent_memory_member;
