-- THROWAWAY spike schema. Dropped after the spike: drop schema spike cascade;
create extension if not exists vector with schema extensions;
create schema if not exists spike;
create table if not exists spike.memories (
  id bigint generated always as identity primary key,
  content text not null,
  embedding extensions.vector(384) not null,
  fts tsvector generated always as (to_tsvector('english', content)) stored
);
create index if not exists memories_fts on spike.memories using gin (fts);
create index if not exists memories_hnsw on spike.memories
  using hnsw (embedding extensions.vector_cosine_ops);

-- Hybrid search: full-text rank + cosine, fused with RRF (k = 60), over-fetch 4x.
create or replace function spike.hybrid_search(q text, qv extensions.vector(384), lim int)
returns table (id bigint, content text, score float8)
language sql stable set search_path = spike, extensions, public as $$
  with kw as (
    select m.id, row_number() over (order by ts_rank_cd(m.fts, websearch_to_tsquery('english', q)) desc) as r
    from spike.memories m
    where m.fts @@ websearch_to_tsquery('english', q)
    limit lim * 4
  ), sem as (
    select m.id, row_number() over (order by m.embedding <=> qv) as r
    from spike.memories m
    order by m.embedding <=> qv
    limit lim * 4
  )
  select m.id, m.content,
         coalesce(1.0 / (60 + kw.r), 0) + coalesce(1.0 / (60 + sem.r), 0) as score
  from kw full join sem on kw.id = sem.id
  join spike.memories m on m.id = coalesce(kw.id, sem.id)
  order by score desc
  limit lim;
$$;

-- Filler rows with random vectors so the indexes and RRF work at a realistic size (~3000 memories).
insert into spike.memories (content, embedding)
select
  'memory ' || g || ' about ' ||
  (array['batteries','solar','tariff','octopus','inverter','givenergy','forecast','plan','export','charge',
         'discharge','debug','home assistant','predbat','test','release','config','sensor','api','cloud'])[1 + g % 20]
  || ' and ' ||
  (array['bug','fix','regression','timeout','slow','crash','calculation','window','rate','soc'])[1 + (g * 7) % 10]
  || repeat(' filler text for realistic length', 10),
  (select array_agg(random() - 0.5)::extensions.vector(384) from generate_series(1, 384) where g > 0)
from generate_series(1, 3000) g
where not exists (select 1 from spike.memories limit 1);
