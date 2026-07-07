-- 11) ADDITIVE — parent_links verification (child approves the parent)
--     approved_at was previously never set by anything. This adds the
--     narrowest mechanism that doesn't need new email infra: a parent (with
--     their own account) requests a link to a child's account by email via
--     request_parent_link(); the child is the ONLY one who can set
--     approved_at (see parent_links_approve below — parent_profile_id is
--     deliberately excluded from that policy's USING clause). This is a
--     mutual-consent safeguard, not verified parental identity/COPPA-grade
--     consent — get legal input before relying on it for real minors.
-- ============================================================

-- request a link by email without exposing profiles to arbitrary lookup:
-- SECURITY DEFINER bypasses profiles RLS internally for the email match,
-- but only ever returns a boolean — never the looked-up id/row itself.
create or replace function request_parent_link(p_child_email text, p_relationship text default null)
returns boolean language plpgsql security definer as $$
declare v_child uuid;
begin
  if auth.uid() is null then return false; end if;

  select id into v_child from profiles where email = p_child_email;
  if v_child is null or v_child = auth.uid() then return false; end if;

  insert into parent_links (parent_profile_id, child_profile_id, relationship)
  values (auth.uid(), v_child, p_relationship)
  on conflict (parent_profile_id, child_profile_id) do nothing;

  return true;
end $$;

revoke all on function request_parent_link(text, text) from public;
grant execute on function request_parent_link(text, text) to authenticated;

-- only the CHILD side of a pending link can approve it
drop policy if exists parent_links_approve on parent_links;
create policy parent_links_approve on parent_links
  for update using (child_profile_id = auth.uid())
  with check (child_profile_id = auth.uid());

-- either side can remove a link (deny a pending request, or revoke an approved one)
drop policy if exists parent_links_delete on parent_links;
create policy parent_links_delete on parent_links
  for delete using (parent_profile_id = auth.uid() or child_profile_id = auth.uid());

-- both sides of a parent_links row (pending or approved) need to see each
-- other's name/email to make an informed approve/deny decision — profiles_self
-- alone won't allow that (is_parent_of() requires approved_at, which is the
-- thing being decided). This is scoped strictly to pairs with an existing
-- parent_links row, not a general profiles read.
drop policy if exists profiles_linked on profiles;
create policy profiles_linked on profiles
  for select using (
    exists (select 1 from parent_links where parent_profile_id = auth.uid() and child_profile_id = profiles.id)
    or exists (select 1 from parent_links where child_profile_id = auth.uid() and parent_profile_id = profiles.id)
  );

-- ============================================================
-- Done (for real this time). Still true:
--  - This is mutual in-app consent, not identity-verified parental consent.
--    A bad actor who also controls (or fakes) the "child" side could still
--    self-approve. Don't market this as COPPA/GDPR-K compliant as-is.
-- ============================================================
