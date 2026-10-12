-- ============================================================================
-- 016 — Purchase Indent: a genuine UNAPPROVE action (APPROVED -> DRAFT),
-- distinct from REJECT (APPROVED -> REJECTED).
--
-- Both are real, separate business decisions: REJECT is a permanent negative
-- decision; UNAPPROVE is an approver pulling their own (or another
-- approver's) decision back for correction, exactly mirroring the existing
-- REOPEN action (REJECTED -> DRAFT) but starting from APPROVED instead. The
-- indent_approvals audit trail already stores `action` as free text with no
-- CHECK violation risk elsewhere — only its own CHECK constraint needs
-- widening to accept the new value.
-- ============================================================================

ALTER TABLE indent_approvals DROP CONSTRAINT chk_indent_approval_action;
ALTER TABLE indent_approvals ADD CONSTRAINT chk_indent_approval_action CHECK (action IN
  ('SUBMIT', 'APPROVE', 'REJECT', 'CANCEL', 'REOPEN', 'CLOSE', 'UNAPPROVE'));
