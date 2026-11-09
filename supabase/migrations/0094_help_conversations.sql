-- 0094 — HELP CONVERSATIONS (2026-11-09).
--
-- The Help assistant's conversations, saved to the account so they survive across devices and sessions. One row per
-- conversation, one per message. A conversation belongs to exactly one user: the routes (service role, after
-- requireUser) read and write only rows whose user_id is the caller's; nobody else's conversation is ever returned,
-- including an administrator's view through these routes. A user deletes their own (soft: deleted_at).
--
-- survey_id records the project the conversation was held in (context and AI billing); it is set null if the project
-- is deleted, and the conversation stays the user's.
--
-- Reached only through /api/help/* (service role): no grants to anon or authenticated.

begin;

create table if not exists public.help_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  customer_id uuid,
  survey_id uuid references public.surveys(id) on delete set null,
  title text not null default 'Help',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint help_conversations_title check (length(title) between 1 and 200)
);
create index if not exists help_conversations_user_idx on public.help_conversations (user_id, updated_at desc) where deleted_at is null;

create table if not exists public.help_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.help_conversations(id) on delete cascade,
  role text not null,
  -- user: { text }   assistant: the answer (mode, answer, sources, followUps, clarify, intelligent, origin, note, charge)
  content jsonb not null,
  created_at timestamptz not null default now(),
  constraint help_messages_shape check (role in ('user', 'assistant') and jsonb_typeof(content) = 'object' and pg_column_size(content) <= 65536)
);
create index if not exists help_messages_conversation_idx on public.help_messages (conversation_id, created_at);

alter table public.help_conversations enable row level security;
alter table public.help_messages enable row level security;
revoke all on public.help_conversations from anon, authenticated;
revoke all on public.help_messages from anon, authenticated;

comment on table public.help_conversations is 'Help assistant conversations, one per row, owned by user_id. Read and written only by /api/help/* for their owner.';
comment on table public.help_messages is 'Messages of a Help conversation: the user''s question and the assistant''s answer (with its sources).';

commit;
