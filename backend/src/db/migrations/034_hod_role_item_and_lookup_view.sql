-- ============================================================================
-- 034 — The HOD role may search the items and masters a requisition needs
--
-- Additive only: two grants to one role. No business record is touched.
--
-- C40 (S1-D10, 2026-10-17 browser E2E; review of 2026-10-18): the HOD role was
-- created on production by scripts/reconcile_all_department_hods_and_roles.ts
-- with requisition.view, create, edit, approve and print, and nothing else.
-- Every role that raises requisitions in auth/permissions.ts also holds
-- item.view and lookup.view (EMPLOYEE's baseline), and the requisition form
-- needs item.view twice: its item picker asks /items/search, and choosing an
-- item asks /items/:id/profile. An account holding only HOD therefore opened
-- Create Requisition and found no item at all ("You cannot search items: your
-- role does not include item.view"). The real HODs also hold EMPLOYEE, so
-- only such an account was blocked.
--
-- The reconcile script grants both since 2026-10-18, but it also rewrites
-- every department's HOD from fixed user ids and is not run again; and the
-- seed never changes the rights of a role that already exists (seed.ts
-- seedRoles: "ship such a change as a migration"). Granted once: a right an
-- administrator later removes on the Roles screen stays removed. Where there
-- is no HOD role (a new database) nothing is inserted.
-- ============================================================================

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.code IN ('item.view', 'lookup.view')
 WHERE r.code = 'HOD'
ON CONFLICT DO NOTHING;
