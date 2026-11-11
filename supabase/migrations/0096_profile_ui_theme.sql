-- 0096 — THE PERSON'S STUDIO THEME (2026-11-11).
--
-- One nullable column on profiles: the id of the colour theme a person chose for the Studio ("reslens", "dark",
-- "ocean" …; apps/studio/lib/theme/themes.ts). Null = the default. It is a personal appearance setting — it
-- changes no survey and nothing another person sees — so it lives on the person's own row and needs no new policy:
-- the Studio reads and writes it through /api/profile/theme with the service role, for the signed-in user only.
--
-- Additive and safe to run twice. Until it is applied the Studio keeps the choice in the browser.

alter table public.profiles add column if not exists ui_theme text;
alter table public.profiles drop constraint if exists profiles_ui_theme_shape;
alter table public.profiles add constraint profiles_ui_theme_shape check (ui_theme is null or ui_theme ~ '^[a-z][a-z0-9_-]{0,31}$');

comment on column public.profiles.ui_theme is 'Studio colour theme chosen by this person (null = default). Personal appearance only.';
