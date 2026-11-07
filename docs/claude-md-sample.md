# Sample CLAUDE.md section for agent-memory users

Copy the section below into your own `~/.claude/CLAUDE.md` (for every project) or into a repo's `CLAUDE.md`. Then edit
the parts in `<angle brackets>`. It tells Claude **when** and **why** to use the shared memory and its threads. **How**
to call each tool is already in the tool descriptions the server sends, so it isn't repeated here.

It assumes you've connected the server as in the README ("Connect an agent"). Replace `shared-memory` with whatever
name you gave it in `claude mcp add`.

---

```markdown
## Shared memory and threads (the `shared-memory` MCP server)

The `shared-memory` server is the record of **what I'm working on** and **what I've learnt**. It lasts across sessions
and repos, and other people and bots can read it. Use it in preference to working context out again from git history or
from scratch.

### Scopes

Memories and threads live in **scopes**. Every write needs one, and reads cover every scope I can read unless I narrow
them. Run `list_scopes` to see what exists and whether I can write to each one.

| Scope | Use it for |
|-------|------------|
| `<team-scope>` | <shared engineering knowledge and work status for the team> |
| `<private-scope>` | <anything that must not reach the wider group> |

Anyone with read access to a scope can see everything in it, including its threads. Before writing, check who reads
that scope. If a finding came from somewhere private, store a version with the private details taken out.

### At the start of a session

- When I pick work up, or ask "where was I" or "what's left", call `recall` with the relevant topics before answering.
  Those questions are answered by earlier sessions, not by this conversation.
- If a status memory names a thread session label (see below), call `whats_new` with that label before carrying on.
  Someone may have answered a question or posted a finding since.

### Recording work status

Store a memory when starting a task, reviewing a PR or ticket, or parking something unfinished. Use category
`observation` and always tag:

- `repo:<name>`, always, so cross-repo queries can tell whose work it is;
- exactly one of `status:open`, `status:in-review`, `status:blocked` or `status:done`;
- `pr:<number>` / `issue:<number>` when there is one.

Write it so it still makes sense in six months: what the work is, where it got to, and what the next action is.

**When the state changes, `update` the existing memory. Never store a second one.** Find it first (search by its
`repo:`/`pr:` tags), then change the text and swap the `status:` tag. Two memories for one piece of work is how "what's
left" ends up returning things that shipped weeks ago. If a duplicate has crept in, delete the stale one.

### Recording what I've learnt

Store durable findings with the category that fits (`architecture`, `bug-fix`, `debugging`, `performance`, `security`,
`learning`, `tool-usage`), tagged with `repo:<name>` and topic tags. Durable findings include:

- a design decision and the reasons for it;
- a constraint that isn't obvious;
- a trap that cost real time;
- what was tried and rejected.

Store the *why*, not the diff: git already has the diff.

Never store secrets, tokens, API keys, credentials or anything from a `.env` file. The store is a shared database
that other people can read. Don't store what the repo already records, or one-off session chatter.

### Threads: when the work is a conversation

A memory holds what is settled. A thread holds the discussion that leads there. Use a thread when:

- several agents or people are working on the same issue and need to hand findings to each other;
- I have a question that someone else (another agent, or a human later) needs to answer;
- the status is moving faster than a memory should be rewritten.

How to work with threads:

- **Open the thread in the same scope as the work**, with a title that says what it is about. Link it to the status
  memory, and to any finding memories as they're written, so `recall` shows the discussion next to the facts.
- **Pick a session label for this piece of work**, such as `<repo>-<topic>`, and use it on the first thread call. The
  label is how I find my session again after the conversation is summarised or restarted. Write the label into the
  status memory too.
  - Keep the session id the server returns and pass it back on later calls. If I lose it, use the label.
  - If several agents share my token, give each one its own label.
- **Posts are permanent, signed and read by others.** Make each post stand on its own: what I found, the evidence,
  and what I'm doing next. When I ask a question, say what answer I need and what I'll do with it.
- **Check `whats_new`** when I resume work and between steps of long work, then read the threads it lists.
- **When the issue is settled, resolve the thread with a note that states the outcome.** Then put the conclusion
  into a memory: update the status memory, or store the finding. Never leave a conclusion only in a thread.
- **Reopen rather than start a duplicate** if a resolved issue comes back.
```
