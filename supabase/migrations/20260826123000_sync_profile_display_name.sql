-- Keep the public profile projection aligned with the user-editable name in
-- Supabase Auth. The mobile client updates Auth metadata; administrators and
-- backend flows read public.profiles.display_name.

CREATE OR REPLACE FUNCTION public.sync_profile_display_name()
RETURNS trigger AS $$
DECLARE
  requested_name text;
BEGIN
  requested_name := COALESCE(
    NULLIF(BTRIM(new.raw_user_meta_data->>'display_name'), ''),
    NULLIF(BTRIM(new.raw_user_meta_data->>'full_name'), ''),
    NULLIF(BTRIM(new.raw_user_meta_data->>'name'), '')
  );

  UPDATE public.profiles
     SET display_name = requested_name
   WHERE id = new.id
     AND display_name IS DISTINCT FROM requested_name;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.sync_profile_display_name()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_profile_metadata_updated ON auth.users;
CREATE TRIGGER on_auth_user_profile_metadata_updated
  AFTER UPDATE OF raw_user_meta_data ON auth.users
  FOR EACH ROW
  WHEN (old.raw_user_meta_data IS DISTINCT FROM new.raw_user_meta_data)
  EXECUTE FUNCTION public.sync_profile_display_name();

-- Backfill existing accounts so the app, profile table, and admin view agree
-- immediately when this migration is applied.
UPDATE public.profiles AS profile
   SET display_name = COALESCE(
     NULLIF(BTRIM(user_record.raw_user_meta_data->>'display_name'), ''),
     NULLIF(BTRIM(user_record.raw_user_meta_data->>'full_name'), ''),
     NULLIF(BTRIM(user_record.raw_user_meta_data->>'name'), '')
   )
  FROM auth.users AS user_record
 WHERE profile.id = user_record.id
   AND profile.display_name IS DISTINCT FROM COALESCE(
     NULLIF(BTRIM(user_record.raw_user_meta_data->>'display_name'), ''),
     NULLIF(BTRIM(user_record.raw_user_meta_data->>'full_name'), ''),
     NULLIF(BTRIM(user_record.raw_user_meta_data->>'name'), '')
   );
