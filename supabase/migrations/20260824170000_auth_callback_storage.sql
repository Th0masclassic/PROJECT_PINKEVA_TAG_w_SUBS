-- The email callback page is public by design: it contains no application
-- data and only forwards the one-time Auth callback parameters to the native
-- app after the user taps the button.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pinkeva-auth',
  'pinkeva-auth',
  true,
  1048576,
  array['text/html']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
