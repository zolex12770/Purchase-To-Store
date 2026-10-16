/**
 * Design-system primitives (SRS §15, §36; redesign spec §3).
 *
 * Every interactive element here ships its hover, focus, disabled, loading and
 * pressed states, so no screen has to reinvent them. v3 adds the pieces the
 * page groups build on: IconButton, Tooltip, Popover, OverflowMenu, Segmented,
 * overflow-aware Tabs, focus-managed Modal/Drawer/ConfirmDialog, and honest
 * empty/loading/error states.
 *
 * Overlays share one Escape stack: Escape closes only the top-most layer, so a
 * menu or dropdown open inside a modal closes before the modal does.
 */
import {
  Children, Fragment, cloneElement, forwardRef, isValidElement, useCallback, useEffect, useId,
  useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactElement,
  type ReactNode, type RefObject, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import {
  X, AlertCircle, AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Inbox, Search,
  Check, MoreHorizontal, RotateCcw,
} from 'lucide-react';
import { statusMeta, categoryIdentity, movementMeta, type Tone } from '../lib/status';

/* ═══════════════════════════ OVERLAY PLUMBING ═════════════════════════ */

interface Layer { onEscape: () => void; isBlocked: () => boolean }
const layers: Layer[] = [];

function onLayerKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || layers.length === 0 || e.defaultPrevented) return;
  const top = layers[layers.length - 1]!;
  e.preventDefault();
  if (!top.isBlocked()) top.onEscape();
}

/**
 * Registers an open overlay. Escape calls `onEscape` of the most recently
 * opened one only. v2 popovers had no key handler at all (the user menu and the
 * notifications stayed open on Escape, audit UI-028), and every modal listened
 * on its own, so one Escape could close a dropdown AND the dialog under it.
 */
export function useEscapeLayer(active: boolean, onEscape: () => void, blocked = false): void {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { onEscape: () => escapeRef.current(), isBlocked: () => blockedRef.current };
    layers.push(layer);
    if (layers.length === 1) document.addEventListener('keydown', onLayerKeyDown);
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      if (layers.length === 0) document.removeEventListener('keydown', onLayerKeyDown);
    };
  }, [active]);
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

const focusablesIn = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]'));

const traps: HTMLElement[] = [];

function onTrapKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Tab' || traps.length === 0) return;
  const root = traps[traps.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  // Focus inside a dropdown portaled out of the dialog is that dropdown's business.
  if (active && active !== document.body && !root.contains(active)) return;
  const list = focusablesIn(root);
  if (list.length === 0) { e.preventDefault(); root.focus(); return; }
  const first = list[0]!;
  const last = list[list.length - 1]!;
  if (e.shiftKey && (active === first || active === root || !active || active === document.body)) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (active === last || !active || active === document.body)) {
    e.preventDefault(); first.focus();
  }
}

/** First field, else the marked or last footer button, else nothing (the panel itself). */
function initialFocusTarget(panel: HTMLElement): HTMLElement | null {
  const marked = panel.querySelector<HTMLElement>('[data-autofocus]');
  if (marked) return marked;
  const body = panel.querySelector<HTMLElement>('.modal-body') ?? panel;
  const field = Array.from(body.querySelectorAll<HTMLElement>(
    'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select:not([disabled]), textarea:not([disabled])',
  )).find((el) => el.getClientRects().length > 0 && !(el as HTMLInputElement).readOnly);
  if (field) return field;
  const footer = panel.querySelector<HTMLElement>('.modal-footer');
  if (footer) {
    const preferred = footer.querySelector<HTMLElement>('[data-initial-focus]:not([disabled])');
    if (preferred) return preferred;
    const buttons = focusablesIn(footer);
    if (buttons.length) return buttons[buttons.length - 1]!;
  }
  return null;
}

/**
 * Dialog focus contract (spec §3.9): focus moves inside on open, Tab stays
 * inside, and focus returns to the trigger on close. v2 ConfirmDialog and the
 * Live Data Verify modal opened with focus left on the page behind them.
 */
function useDialogFocus(open: boolean, panelRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    traps.push(panel);
    if (traps.length === 1) document.addEventListener('keydown', onTrapKeyDown);
    // After children have mounted, so their own autoFocus wins.
    const raf = requestAnimationFrame(() => {
      if (panel.contains(document.activeElement)) return;
      (initialFocusTarget(panel) ?? panel).focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      const i = traps.indexOf(panel);
      if (i >= 0) traps.splice(i, 1);
      if (traps.length === 0) document.removeEventListener('keydown', onTrapKeyDown);
      if (trigger && trigger.isConnected && trigger !== document.body) trigger.focus({ preventScroll: true });
    };
  }, [open, panelRef]);
}

let scrollLocks = 0;
let savedOverflow = '';
/** Locks page scroll behind modals; counted, so nested dialogs restore correctly. */
function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (scrollLocks++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    return () => {
      if (--scrollLocks === 0) document.body.style.overflow = savedOverflow;
    };
  }, [active]);
}

/* ═══════════════════════════ BUTTON ═══════════════════════════════════ */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ghost-danger' | 'link'
  /** v2 names: both now render as primary (approve is the primary action; gold has no role). */
  | 'success' | 'accent';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  block?: boolean;
}

/**
 * True when a button shows only icons. v2 callers pass the icon as the only
 * child (`<Button><Check size={14} /></Button>`), so "no children" missed them
 * and they never got the square shape. An icon child is a self-closing
 * component element; anything with text or nested children is a label.
 */
function isIconOnly(children: ReactNode): boolean {
  const kids = Children.toArray(children);
  if (kids.length === 0) return true;
  return kids.every((k) => isValidElement(k)
    && typeof k.type !== 'string'
    && (k.props as { children?: unknown }).children === undefined);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'secondary', size = 'md', loading = false, icon, iconRight,
  block, children, className = '', disabled, type = 'button', ...rest
}, ref) {
  const iconOnly = isIconOnly(children) && !iconRight;
  const classes = [
    'btn', `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : size === 'xs' ? 'btn-xs' : '',
    iconOnly ? 'btn-icon' : '',
    block ? 'btn-block' : '',
    className,
  ].filter(Boolean).join(' ');

  // An icon-only button must still have a name; v2 callers put it in `title`.
  const ariaLabel = rest['aria-label'] ?? (iconOnly && typeof rest.title === 'string' ? rest.title : undefined);

  return (
    <button ref={ref} type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest} aria-label={ariaLabel}>
      {/* A loading button is disabled, which is what stops duplicate submission (SRS §36). */}
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  );
});

/**
 * Square icon-only button with a mandatory accessible name and a tooltip
 * (spec §3.5). 28 px by default — the row-action size.
 */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'children' | 'icon' | 'iconRight'> & {
  label: string;
  icon: ReactNode;
  /** Tooltip text; defaults to `label`. `false` for none (e.g. a dialog's close button). */
  tooltip?: ReactNode | false;
}>(function IconButton({ label, icon, tooltip, variant = 'ghost', size = 'sm', ...rest }, ref) {
  const button = (
    <Button ref={ref} variant={variant} size={size} aria-label={label} {...rest}>
      {icon}
    </Button>
  );
  return tooltip === false ? button : <Tooltip content={tooltip ?? label}>{button}</Tooltip>;
});

/* ═══════════════════════════ TOOLTIP ══════════════════════════════════ */

/**
 * Hover and keyboard-focus tooltip (spec §3.15): inverse surface, 400 ms
 * delay on hover, immediate on focus, dismissed by Escape. Replaces multi-line
 * native `title=` tooltips, which keyboard users never see.
 */
export function Tooltip({
  content, children, placement = 'top', delay = 400, block,
}: {
  content: ReactNode; children: ReactElement; placement?: 'top' | 'bottom'; delay?: number;
  /** Anchor fills its container (a tooltip over a whole card in a grid cell). */
  block?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();

  const show = (immediate: boolean) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), immediate ? 0 : delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const a = anchorRef.current;
    const b = bubbleRef.current;
    if (!a || !b) return;
    const r = a.getBoundingClientRect();
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const above = placement === 'top' ? r.top - bh - 8 >= 4 : r.bottom + bh + 8 > window.innerHeight;
    const top = above ? r.top - bh - 8 : r.bottom + 8;
    const left = Math.max(6, Math.min(r.left + r.width / 2 - bw / 2, window.innerWidth - bw - 6));
    setPos({ left, top });
  }, [open, placement, content]);

  if (content === null || content === undefined || content === '') return children;

  const trigger = cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
    'aria-describedby': open ? id : (children.props as { 'aria-describedby'?: string })['aria-describedby'],
  });

  return (
    <span
      ref={anchorRef}
      className={`tooltip-anchor ${block ? 'tooltip-block' : ''}`}
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
      onFocus={(e) => { if ((e.target as HTMLElement).matches(':focus-visible')) show(true); }}
      onBlur={hide}
      onMouseDown={hide}
      onKeyDown={(e) => { if (e.key === 'Escape') hide(); }}
    >
      {trigger}
      {open && createPortal(
        <div
          ref={bubbleRef}
          id={id}
          role="tooltip"
          className="tooltip"
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
        >
          {content}
        </div>,
        document.body,
      )}
    </span>
  );
}

/* ═══════════════════════════ POPOVER & MENU ═══════════════════════════ */

/**
 * A floating panel anchored to a trigger, portaled to <body> so no card,
 * table wrapper or modal can clip it, and repositioned on any scroll.
 */
export function Popover({
  anchorRef, open, onClose, children, align = 'start', offset = 6, minWidth, matchAnchorWidth,
  className = '', role, id, label, restoreFocus = true, style,
}: {
  anchorRef: RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  offset?: number;
  minWidth?: number;
  matchAnchorWidth?: boolean;
  className?: string;
  role?: string;
  id?: string;
  label?: string;
  /** Return focus to the trigger when Escape closes it. */
  restoreFocus?: boolean;
  style?: CSSProperties;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; minWidth?: number; maxHeight: number } | null>(null);

  const place = useCallback(() => {
    const a = anchorRef.current;
    const p = panelRef.current;
    if (!a || !p) return;
    const r = a.getBoundingClientRect();
    const pw = p.offsetWidth;
    const ph = p.offsetHeight;
    const below = window.innerHeight - r.bottom - offset - 8;
    const aboveSpace = r.top - offset - 8;
    const up = ph > below && aboveSpace > below;
    let left = align === 'end' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    setPos({
      top: up ? undefined : r.bottom + offset,
      bottom: up ? window.innerHeight - r.top + offset : undefined,
      left,
      minWidth: matchAnchorWidth ? Math.max(r.width, minWidth ?? 0) : minWidth,
      maxHeight: Math.max(160, up ? aboveSpace : below),
    });
  }, [anchorRef, align, offset, minWidth, matchAnchorWidth]);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose, anchorRef]);

  useEscapeLayer(open, () => {
    onClose();
    if (restoreFocus) anchorRef.current?.focus();
  });

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      className={`popover ${className}`}
      role={role}
      id={id}
      aria-label={label}
      style={{
        position: 'fixed',
        zIndex: 'var(--z-popover)' as unknown as number,
        top: pos?.top,
        bottom: pos?.bottom,
        left: pos?.left ?? -9999,
        minWidth: pos?.minWidth,
        maxHeight: pos?.maxHeight,
        overflowY: 'auto',
        visibility: pos ? 'visible' : 'hidden',
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuAction {
  key?: string;
  label: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Destructive actions render in the danger tone (spec §3.3). */
  destructive?: boolean;
  /** Why it is disabled, or what it does. */
  title?: string;
  separatorBefore?: boolean;
}

/** Arrow keys, Home/End and type-ahead-free roving focus inside a role="menu". */
function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
  if (items.length === 0) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = i <= 0 ? items.length - 1 : i - 1;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  if (next >= 0) { e.preventDefault(); items[next]!.focus(); }
}

/** Focuses the first enabled item when a menu opens. */
export function useMenuAutofocus(open: boolean, menuId: string): void {
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      document.getElementById(menuId)?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, menuId]);
}

/** Menu panel content: items, separators and an optional heading. */
export function MenuList({
  items, onAction, header,
}: { items: MenuAction[]; onAction: (a: MenuAction) => void; header?: ReactNode }) {
  return (
    <>
      {header}
      {items.map((a, i) => (
        <Fragment key={a.key ?? i}>
          {a.separatorBefore && i > 0 && <div className="menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`menu-item ${a.destructive ? 'is-danger' : ''}`}
            disabled={a.disabled}
            title={a.title}
            onClick={() => onAction(a)}
          >
            {a.icon}
            <span className="grow truncate">{a.label}</span>
          </button>
        </Fragment>
      ))}
    </>
  );
}

/**
 * "⋯ More" menu (spec §3.3, §3.15): everything past the page's primary and two
 * secondary actions, and every destructive action, lives here.
 */
export function OverflowMenu({
  items, label = 'More actions', triggerLabel, icon, variant = 'ghost', size = 'sm', align = 'end', header, disabled,
}: {
  items: MenuAction[];
  /** Accessible name (and tooltip) of an icon-only trigger. */
  label?: string;
  /** Show a text trigger ("More") instead of the ⋯ icon. */
  triggerLabel?: ReactNode;
  icon?: ReactNode;
  variant?: 'ghost' | 'secondary';
  size?: 'xs' | 'sm' | 'md';
  align?: 'start' | 'end';
  header?: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useMenuAutofocus(open, menuId);
  const visible = items.filter(Boolean);
  if (visible.length === 0) return null;

  const run = (a: MenuAction) => {
    setOpen(false);
    triggerRef.current?.focus();
    a.onClick?.();
  };

  const common = {
    ref: triggerRef,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => setOpen((v) => !v),
    disabled,
  };

  return (
    <>
      {triggerLabel ? (
        <Button {...common} variant={variant} size={size} icon={icon} iconRight={<ChevronDown size={14} aria-hidden />}>
          {triggerLabel}
        </Button>
      ) : (
        <IconButton {...common} label={label} icon={icon ?? <MoreHorizontal size={16} />} variant={variant} size={size} tooltip={open ? false : label} />
      )}
      <Popover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align={align}>
        <div
          id={menuId}
          role="menu"
          aria-label={typeof triggerLabel === 'string' ? triggerLabel : label}
          className="menu-list"
          onKeyDown={(e) => { onMenuKeyDown(e); if (e.key === 'Tab') setOpen(false); }}
        >
          <MenuList items={visible} onAction={run} header={header} />
        </div>
      </Popover>
    </>
  );
}

/* ═══════════════════════════ CARD ═════════════════════════════════════ */

export function Card({
  children, className = '', onClick, ...rest
}: { children: ReactNode; className?: string; onClick?: () => void } & Record<string, unknown>) {
  const clickable = Boolean(onClick);
  return (
    <div
      className={`card ${clickable ? 'card-clickable' : ''} ${className}`}
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title, subtitle, actions, icon,
}: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card-header">
      {icon && <span style={{ color: 'var(--text-3)', display: 'grid', placeItems: 'center' }}>{icon}</span>}
      <div className="grow">
        <div className="card-title">{title}</div>
        {subtitle && <div className="card-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="row" style={{ gap: 'var(--space-2)' }}>{actions}</div>}
    </div>
  );
}

export const CardBody = ({
  children, flush, className = '', style,
}: {
  children: ReactNode; flush?: boolean; className?: string; style?: CSSProperties;
}) => (
  <div className={`${flush ? 'card-body-flush' : 'card-body'} ${className}`} style={style}>
    {children}
  </div>
);

/* ═══════════════════════════ BADGES & CHIPS ═══════════════════════════ */

export function Badge({
  children, tone = 'neutral', plain, icon, dot = true, strike, title,
}: {
  children: ReactNode;
  tone?: Tone;
  /** No fill — but the tone's text and dot stay (v2 turned every plain badge grey). */
  plain?: boolean;
  icon?: ReactNode;
  dot?: boolean;
  strike?: boolean;
  title?: string;
}) {
  const cls = [
    'badge', `badge-${tone}`, plain ? 'badge-plain' : '', icon ? 'has-icon' : '',
    !dot ? 'no-dot' : '', strike ? 'badge-strike' : '',
  ].filter(Boolean).join(' ');
  return (
    <span className={cls} title={title}>
      {icon && <span className="badge-icon" aria-hidden>{icon}</span>}
      <span className="badge-text">{children}</span>
    </span>
  );
}

/**
 * Status badge from the single status map (lib/status.ts): the same tone,
 * icon and words for a status on every screen; never colour alone.
 */
export function StatusBadge({
  status, plain, label,
}: { status: string | null | undefined; plain?: boolean; label?: ReactNode }) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  return (
    <Badge
      tone={meta.tone}
      plain={plain}
      strike={meta.strike}
      title={meta.description}
      icon={<Icon size={12} strokeWidth={2.25} className={meta.spin ? 'zx-spin' : undefined} />}
    >
      {label ?? meta.label}
      {meta.attention && <span className="badge-attn" aria-hidden />}
    </Badge>
  );
}

/** Inventory category identity: neutral chip + palette swatch (spec §3.6). */
export function CategoryChip({ category }: { category: string | null | undefined }) {
  const c = categoryIdentity(category);
  return (
    <span className="chip chip-neutral" title={c.label}>
      <span className="chip-swatch" style={{ background: c.swatch }} aria-hidden />
      {c.code}
    </span>
  );
}

/** Stock movement type: direction icon in colour, label in ink (spec §3.6). */
export function MovementChip({ type, direction }: { type: string | null | undefined; direction?: string | null }) {
  const mv = movementMeta(type, direction);
  const Icon = mv.icon;
  return (
    <span className="chip chip-neutral">
      <Icon size={13} strokeWidth={2.25} style={{ color: mv.iconColor }} aria-hidden />
      {mv.label}
    </span>
  );
}

/* ═══════════════════════════ FORM ═════════════════════════════════════ */

export function Field({
  label, required, hint, error, children, className = '', span,
}: {
  label?: ReactNode; required?: boolean; hint?: ReactNode; error?: string;
  children: ReactNode; className?: string; span?: 2 | 'full';
}) {
  const autoId = useId();
  const spanClass = span === 2 ? 'field-span-2' : span === 'full' ? 'field-span-full' : '';
  const messageId = `${autoId}-msg`;
  const hasMessage = Boolean(error || hint);

  // Tie the label, hint and error to a single form control so screen readers
  // announce them; a composite child (a picker) is left as it is.
  let control = children;
  let controlId: string | undefined;
  if (isValidElement(children) && typeof children.type !== 'symbol') {
    const props = children.props as { id?: string; 'aria-describedby'?: string };
    controlId = props.id ?? autoId;
    control = cloneElement(children as ReactElement<Record<string, unknown>>, {
      id: controlId,
      'aria-describedby': [props['aria-describedby'], hasMessage ? messageId : undefined].filter(Boolean).join(' ') || undefined,
      ...(error ? { 'aria-invalid': true } : {}),
    });
  }

  return (
    <div className={`field ${spanClass} ${className}`}>
      {label && (
        <label className="field-label" htmlFor={controlId}>
          {label}
          {required && <><span className="req" aria-hidden>*</span><span className="sr-only"> (required)</span></>}
        </label>
      )}
      {control}
      {/* The error replaces the hint so the two never compete for the same slot. */}
      {error ? (
        <span id={messageId} className="field-error"><AlertCircle size={12} aria-hidden /> {error}</span>
      ) : hint ? (
        <span id={messageId} className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  numeric?: boolean;
}
export function Input({ invalid, numeric, className = '', ...rest }: InputProps) {
  return (
    <input
      className={`input ${invalid ? 'input-error' : ''} ${numeric ? 'input-num' : ''} ${className}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  placeholder?: string;
  options?: { value: string | number; label: string }[];
}
export function Select({ invalid, placeholder, options, children, className = '', ...rest }: SelectProps) {
  return (
    <select className={`select ${invalid ? 'select-error' : ''} ${className}`} aria-invalid={invalid || undefined} {...rest}>
      {placeholder && <option value="">{placeholder}</option>}
      {options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {children}
    </select>
  );
}

export function Textarea({ invalid, className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea className={`textarea ${invalid ? 'input-error' : ''} ${className}`} aria-invalid={invalid || undefined} {...rest} />;
}

export function Checkbox({
  label, checked, onChange, disabled,
}: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check-row" style={disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}>
      <input type="checkbox" className="checkbox" checked={checked} disabled={disabled}
             onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/* ═══════════════════════════ SEARCHABLE SELECT ════════════════════════
   Used wherever the SRS calls for a "searchable dropdown" (item / supplier
   selection, §10). Keyboard-navigable; closes on outside click and Escape.  */

export interface Option {
  value: number | string;
  label: string;
  sublabel?: string;
  meta?: string;
}

export function SearchSelect({
  value, onChange, options, placeholder = 'Search…', disabled, invalid, emptyText = 'No matches',
  onSearch, searching, selectedOption,
}: {
  value: number | string | null;
  onChange: (value: number | string | null, option: Option | null) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  emptyText?: string;
  /**
   * Makes the search run on the SERVER. Without it the box only filters the
   * `options` it was handed, which is right for a short master list and badly
   * wrong for a long one: handed the first 50 of 12,000 items, it can never
   * find the other 11,950 however exactly the code is typed. With it, every
   * keystroke is passed up, the caller fetches matching rows, and `options` is
   * shown as given.
   */
  onSearch?: (term: string) => void;
  /** A server search is in flight — shown instead of a premature "no matches". */
  searching?: boolean;
  /** The chosen value's own label, for when it is not among the current `options`. */
  selectedOption?: Option | null;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((o) => String(o.value) === String(value))
    ?? (selectedOption && String(selectedOption.value) === String(value) ? selectedOption : null);

  // With a server search the rows handed in ARE the matches; filtering them
  // again here would hide a hit the server found on a field this box cannot see.
  const filtered = onSearch
    ? options.slice(0, 60)
    : term.trim()
      ? options.filter((o) => {
          const t = term.toLowerCase();
          return o.label.toLowerCase().includes(t) || (o.sublabel ?? '').toLowerCase().includes(t);
        }).slice(0, 60)
      : options.slice(0, 60);

  // Kept in a ref so the effect below depends on the typed term alone — a
  // caller passing a fresh inline function must not re-trigger the search.
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  useEffect(() => { onSearchRef.current?.(term); }, [term]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { setHighlight(0); }, [term]);

  const close = useCallback(() => { setOpen(false); setTerm(''); }, []);
  const choose = (o: Option) => {
    onChange(o.value, o);
    close();
    triggerRef.current?.focus();
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        className={`input ${invalid ? 'input-error' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, textAlign: 'left', width: '100%' }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
      >
        <span className="truncate" style={{ color: selected ? 'var(--text-1)' : 'var(--text-4)', minWidth: 0 }}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--text-3)' }} aria-hidden />
      </button>

      <Popover anchorRef={triggerRef} open={open} onClose={close} matchAnchorWidth minWidth={240}>
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 320 }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border-subtle)', position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-4)' }} aria-hidden />
            <input
              ref={inputRef}
              className="input input-sm"
              style={{ paddingLeft: 30 }}
              value={term}
              placeholder={onSearch ? 'Type to search…' : 'Type to filter…'}
              onChange={(e) => setTerm(e.target.value)}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={filtered[highlight] ? `${listId}-${highlight}` : undefined}
              aria-label={placeholder}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); const o = filtered[highlight]; if (o) choose(o); }
                else if (e.key === 'Tab') close();
              }}
            />
          </div>

          <div id={listId} role="listbox" style={{ overflowY: 'auto', flex: 1, padding: 4 }}>
            {filtered.length === 0 && (
              <div style={{ padding: '14px 12px', fontSize: 'var(--fs-13)', color: 'var(--text-3)', textAlign: 'center' }}>
                {searching ? 'Searching…' : emptyText}
              </div>
            )}
            {filtered.map((o, i) => {
              const isSelected = String(o.value) === String(value);
              return (
                <button
                  key={o.value}
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  className={`option ${i === highlight ? 'is-active' : ''}`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(o)}
                >
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="truncate" style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 500, color: 'var(--text-1)' }}>
                      {o.label}
                    </span>
                    {o.sublabel && (
                      <span className="truncate" style={{ display: 'block', fontSize: 'var(--fs-12)', color: 'var(--text-3)' }}>
                        {o.sublabel}
                      </span>
                    )}
                  </span>
                  {o.meta && <span style={{ fontSize: 'var(--fs-11)', color: 'var(--text-4)', flexShrink: 0 }}>{o.meta}</span>}
                  {isSelected && <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} aria-hidden />}
                </button>
              );
            })}
          </div>
        </div>
      </Popover>
    </div>
  );
}

/* ═══════════════════════════ MODAL ════════════════════════════════════ */

export function Modal({
  open, onClose, title, subtitle, children, footer, size = 'md', closeOnOverlay = true, busy = false, role = 'dialog',
}: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode;
  children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl';
  closeOnOverlay?: boolean;
  /** A mutation is in flight: Escape and the overlay do not close the dialog. */
  busy?: boolean;
  role?: 'dialog' | 'alertdialog';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useEscapeLayer(open, onClose, busy);
  useDialogFocus(open, panelRef);
  useScrollLock(open);

  if (!open) return null;

  return createPortal(
    <div className="overlay" onMouseDown={(e) => { if (closeOnOverlay && !busy && e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        className={`modal modal-${size}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? descId : undefined}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div className="grow" style={{ minWidth: 0 }}>
            <div id={titleId} className="modal-title" role="heading" aria-level={2}>{title}</div>
            {subtitle && <div id={descId} className="modal-subtitle">{subtitle}</div>}
          </div>
          <IconButton label="Close" icon={<X size={16} />} onClick={onClose} disabled={busy} tooltip={false} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ═══════════════════════════ DRAWER ═══════════════════════════════════
   Record quick-view and drill-down that keeps the list visible (SRS §14).    */

export function Drawer({
  open, onClose, title, subtitle, children, footer, wide, actions, busy = false,
}: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode;
  children: ReactNode; footer?: ReactNode; wide?: boolean; actions?: ReactNode;
  busy?: boolean;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descId = useId();
  useEscapeLayer(open, onClose, busy);
  useDialogFocus(open, panelRef);
  useScrollLock(open);

  if (!open) return null;

  return createPortal(
    <>
      <div className="drawer-overlay" onClick={() => { if (!busy) onClose(); }} />
      <aside
        ref={panelRef}
        className={`drawer ${wide ? 'drawer-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? descId : undefined}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div className="grow" style={{ minWidth: 0 }}>
            <div id={titleId} className="modal-title" role="heading" aria-level={2}>{title}</div>
            {subtitle && <div id={descId} className="modal-subtitle">{subtitle}</div>}
          </div>
          {actions}
          <IconButton label="Close" icon={<X size={16} />} onClick={onClose} disabled={busy} tooltip={false} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

/**
 * Confirmation for decisions and irreversible actions (SRS §36). Footer is
 * [Cancel] [Confirm] on the right. Initial focus goes to the reason field when
 * one is required, otherwise to Confirm — except for a destructive confirm,
 * where it rests on Cancel so a stray Enter cannot delete or reject
 * (WAI-ARIA alertdialog guidance).
 */
export function ConfirmDialog({
  open, onClose, onConfirm, title, message, confirmLabel = 'Confirm',
  variant = 'danger', loading, requireReason, reasonLabel = 'Reason', reasonValue, onReasonChange,
}: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: string; message: ReactNode; confirmLabel?: string;
  variant?: Variant; loading?: boolean;
  requireReason?: boolean; reasonLabel?: string;
  reasonValue?: string; onReasonChange?: (v: string) => void;
}) {
  const reason = reasonValue ?? '';
  const blocked = requireReason && !reason.trim();
  const destructive = variant === 'danger' || variant === 'ghost-danger';
  return (
    <Modal
      open={open} onClose={onClose} title={title} size="sm" busy={loading} role="alertdialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading} data-initial-focus={destructive ? '' : undefined}>Cancel</Button>
          <Button
            variant={variant === 'ghost-danger' ? 'danger' : variant}
            onClick={onConfirm}
            loading={loading}
            disabled={blocked}
            data-initial-focus={destructive ? undefined : ''}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 'var(--fs-14)', color: 'var(--text-2)', lineHeight: 1.55 }}>{message}</div>
      {requireReason && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Field
            label={reasonLabel}
            required
            error={blocked && reason.length > 0 ? 'A reason is required.' : undefined}
            hint={`${reason.trim().length} characters · recorded in the audit trail`}
          >
            <Textarea
              value={reason}
              onChange={(e) => onReasonChange?.(e.target.value)}
              placeholder="State the reason — this is recorded in the audit trail."
              rows={3}
              autoFocus
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/* ═══════════════════════════ TABS & SEGMENTED ═════════════════════════ */

export interface TabDef {
  key: string;
  label: string;
  icon?: ReactNode;
  count?: number | string;
  disabled?: boolean;
}

/**
 * View tabs (spec §3.10). When the row overflows, scroll buttons and an edge
 * fade appear — the requisition status tabs hid "Cancelled" at 1440 and 1366
 * with no affordance (audit UI-021). Arrow keys move between tabs.
 */
export function Tabs({
  tabs, active, onChange, ariaLabel,
}: { tabs: TabDef[]; active: string; onChange: (key: string) => void; ariaLabel?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((p) => (p.start === start && p.end === end ? p : { start, end }));
  }, []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', measure); };
  }, [measure, tabs.length]);

  // Keep the active tab in view horizontally (never scrolls the page).
  useEffect(() => {
    const el = listRef.current;
    const tab = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !tab) return;
    if (tab.offsetLeft < el.scrollLeft) el.scrollLeft = tab.offsetLeft - 32;
    else if (tab.offsetLeft + tab.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = tab.offsetLeft + tab.offsetWidth - el.clientWidth + 32;
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : e.key === 'ArrowRight' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    e.preventDefault();
    items[next]?.focus();
  };

  const scrollBy = (dx: number) => listRef.current?.scrollBy({ left: dx, behavior: 'smooth' });
  // Roving tabindex; when no tab matches `active` the first stays reachable.
  const focusKey = tabs.some((t) => t.key === active) ? active : tabs[0]?.key;

  return (
    <div className="tabs-wrap">
      {edges.start && (
        <button type="button" className="tabs-scroll is-start" tabIndex={-1} aria-hidden onClick={() => scrollBy(-220)}>
          <ChevronLeft size={16} />
        </button>
      )}
      <div ref={listRef} className="tabs" role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active === t.key}
            tabIndex={focusKey === t.key ? 0 : -1}
            disabled={t.disabled}
            className={`tab ${active === t.key ? 'active' : ''}`}
            onClick={() => onChange(t.key)}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && <span className="tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      {edges.end && (
        <button type="button" className="tabs-scroll is-end" tabIndex={-1} aria-hidden onClick={() => scrollBy(220)}>
          <ChevronRight size={16} />
        </button>
      )}
    </div>
  );
}

export interface SegmentOption {
  value: string;
  label: ReactNode;
  count?: number | string;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

/**
 * Segmented control (spec §3.10): one choice that filters a single list —
 * status, category, Day/Week/Month. A radiogroup, so the selection is
 * announced and arrow keys move it.
 */
export function Segmented({
  options, value, onChange, ariaLabel, size = 'md', className = '',
}: {
  options: SegmentOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = enabled[(i + step + enabled.length) % enabled.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    requestAnimationFrame(() => e.currentTarget?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  const focusValue = options.some((o) => o.value === value) ? value : options[0]?.value;
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`segmented ${size === 'sm' ? 'segmented-sm' : ''} ${className}`} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={o.value === focusValue ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            className="segmented-item"
            onClick={() => onChange(o.value)}
          >
            {o.icon}
            {o.label}
            {o.count !== undefined && <span className="tab-count">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════ STATES (spec §3.14) ══════════════════════ */

export const Spinner = ({ large }: { large?: boolean }) => (
  <span className={`spinner ${large ? 'spinner-lg' : ''}`} role="status" aria-label="Loading" />
);

/** Says so when a load runs long (the PO lists take ~8 s on staging, audit UI-027). */
function useSlow(ms = 2000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return slow;
}

/** Content skeleton in place of a section that is loading. Never a zero. */
export function LoadingBlock({ label = 'Loading…', height = 220 }: { label?: string; height?: number }) {
  const slow = useSlow();
  return (
    <div role="status" aria-live="polite" style={{ minHeight: height, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, padding: 'var(--space-4)' }}>
      <Skeleton w="38%" h={14} />
      <Skeleton w="92%" h={10} />
      <Skeleton w="84%" h={10} />
      <Skeleton w="66%" h={10} />
      <div className="state-slow">{slow ? 'Still loading — large list' : label}</div>
    </div>
  );
}

export function EmptyState({
  icon, title, message, action, secondaryAction,
}: { icon?: ReactNode; title: string; message?: ReactNode; action?: ReactNode; secondaryAction?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden>{icon ?? <Inbox />}</div>
      <div className="empty-title">{title}</div>
      {message && <div className="empty-text">{message}</div>}
      {(action || secondaryAction) && <div className="empty-actions">{secondaryAction}{action}</div>}
    </div>
  );
}

/** Error with the API message, the request id when there is one, and a retry. */
export function ErrorState({
  error, onRetry, title = 'Could not load this information',
}: { error: unknown; onRetry?: () => void; title?: string }) {
  const message = error instanceof Error ? error.message
    : typeof error === 'string' ? error
      : 'An unexpected error occurred.';
  const requestId = typeof error === 'object' && error !== null && 'requestId' in error
    ? (error as { requestId?: string }).requestId
    : undefined;
  return (
    <div className="empty-state error-state" role="alert">
      <div className="empty-icon" aria-hidden><AlertTriangle /></div>
      <div className="empty-title">{title}</div>
      <div className="empty-text">{message}</div>
      {requestId && <div className="error-meta">Request {requestId}</div>}
      {onRetry && (
        <div className="empty-actions">
          <Button variant="secondary" size="sm" icon={<RotateCcw size={14} />} onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}

/** Inline notice; danger when a background refetch failed but cached data stays on screen. */
export function Banner({
  tone = 'info', children, action,
}: { tone?: 'info' | 'warning' | 'danger'; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'info' ? AlertCircle : AlertTriangle;
  return (
    <div className={`banner ${tone === 'info' ? '' : `banner-${tone}`}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={16} aria-hidden />
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

export const Skeleton = ({ w = '100%', h = 14, r }: { w?: string | number; h?: number; r?: number }) => (
  <div className="skeleton" style={{ width: w, height: h, borderRadius: r ?? 'var(--radius-2xs)' }} />
);

export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  const slow = useSlow();
  return (
    <div role="status" aria-live="polite" aria-label="Loading" style={{ padding: 'var(--space-3) var(--space-3) var(--space-4)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-4)', paddingBottom: 'var(--space-3)', marginBottom: 'var(--space-2)', borderBottom: '1px solid var(--border-subtle)' }}>
        {Array.from({ length: cols }).map((_, i) => <Skeleton key={i} h={10} w={i === 0 ? 96 : 64} />)}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'flex', gap: 'var(--space-4)', padding: '9px 0', borderBottom: '1px solid var(--border-subtle)' }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} h={12} w={c === 0 ? 120 : `${48 + ((r + c) % 4) * 12}px`} />
          ))}
        </div>
      ))}
      {slow && <div className="state-slow">Still loading — large list</div>}
    </div>
  );
}

/* ═══════════════════════════ MISC ═════════════════════════════════════ */

const PROGRESS_FILL: Record<Tone, string> = {
  neutral: 'var(--tone-neutral-solid)',
  pending: 'var(--tone-pending-solid)',
  warning: 'var(--tone-pending-solid)',
  attention: 'var(--tone-attention-solid)',
  info: 'var(--tone-info-solid)',
  progress: 'var(--tone-progress-solid)',
  success: 'var(--tone-success-solid)',
  danger: 'var(--tone-danger-solid)',
  closed: 'var(--tone-closed-solid)',
  void: 'var(--tone-void-solid)',
};

export function ProgressBar({ value, tone = 'info', label }: { value: number; tone?: Tone; label?: string }) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className="progress-track" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${pct}%`, background: PROGRESS_FILL[tone] }} />
    </div>
  );
}

/** An applied filter value with a remove button. */
export const Chip = ({ children, onRemove }: { children: ReactNode; onRemove?: () => void }) => (
  <span className="chip">
    {children}
    {onRemove && <button type="button" onClick={onRemove} aria-label="Remove filter"><X size={12} /></button>}
  </span>
);

/** Label/value pair used throughout detail views and print layouts. */
export function DetailItem({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 'var(--fs-12)', fontWeight: 500, color: 'var(--text-3)', marginBottom: 2 }}>
        {label}
      </div>
      <div className={mono ? 'mono' : ''} style={{ fontSize: 'var(--fs-14)', color: 'var(--text-1)', fontWeight: 500, overflowWrap: 'anywhere' }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Label/value grid.
 *
 * `cols` is the target at full width; the track minimum is sized so the grid
 * genuinely reaches that many columns inside a normal card, and degrades one
 * column at a time as the container narrows.
 */
export const DetailGrid = ({ children, cols = 4 }: { children: ReactNode; cols?: number }) => {
  const min = cols >= 4 ? 165 : cols === 3 ? 180 : 220;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`,
        gap: 'var(--space-4) var(--space-5)',
      }}
    >
      {children}
    </div>
  );
};

/** Section heading inside a page or drawer. Sentence case, with a hairline. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="row" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
      <h3 style={{ fontSize: 'var(--fs-14)', fontWeight: 600, color: 'var(--text-1)', letterSpacing: 0, whiteSpace: 'nowrap' }}>
        {children}
      </h3>
      <div className="grow" style={{ height: 1, background: 'var(--border-subtle)' }} />
      {action}
    </div>
  );
}

/** Copies text to the clipboard with transient feedback. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [value]);
  return (
    <Button variant="ghost" size="sm" onClick={copy} icon={copied ? <Check size={13} /> : undefined}>
      {copied ? 'Copied' : label}
    </Button>
  );
}
