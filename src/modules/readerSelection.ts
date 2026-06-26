import { getPref } from "../utils/prefs";

/**
 * Reader Selection overlay.
 *
 * A Mendeley-style custom text-selection overlay for Zotero's PDF reader.
 *
 * Zotero's native PDF text selection paints a tall, light-blue band (the line
 * client rect is ~25px tall while the glyph box is only ~17.6px, which is why
 * the native selection looks bloated). We KEEP the native selection mechanics
 * intact (so copy, annotation creation, and the Zotero selection popup keep
 * working) but HIDE its paint via CSS and draw our OWN overlay on top: snug
 * purple rectangles that hug the text, recentred at a fraction of the line box,
 * plus blue end-handle bars (a small ball at the TOP of the start bar and a
 * small ball at the BOTTOM of the end bar, like Mendeley).
 *
 * Safety: we only OBSERVE the selection (selectionchange / pointerup) and draw.
 * We NEVER preventDefault, NEVER modify the range/selection, NEVER
 * stopPropagation, and every overlay node is pointer-events:none, so we cannot
 * intercept clicks or break native behaviour. Every reader-touching operation
 * is wrapped in try/catch so a failure on one reader can never throw into
 * Zotero or break the others. State is per-reader in a Map and fully cleaned up
 * (rAF, listeners, injected <style>, overlay) on detach, so it is idempotent
 * and leak-free.
 *
 * Drawing follows scrolling and zoom by re-reading the range client rects each
 * animation frame while the selection is non-collapsed; a cheap signature
 * (rect count + first/last rounded coords) skips redundant DOM writes, and the
 * rAF loop stops as soon as the selection collapses.
 */

// ---- constants -------------------------------------------------------------

const STYLE_ID = "stylero-reader-selection";
const OVERLAY_CLASS = "stylero-sel-overlay";
const RECT_CLASS = "stylero-sel-rect";
const HANDLE_CLASS = "stylero-sel-handle";
const BALL_CLASS = "stylero-sel-ball";

const FALLBACK_ADDON_ID = "zotero-stylero@jose.local";
/** A render-type event fires for newly-opened readers; we use it to attach. */
const READER_EVENT_TYPE = "renderToolbar";
/** Defensive fallback poll for readers the event might miss. */
const POLL_INTERVAL_MS = 1500;
/** Retries while the inner viewer iframe is still loading on open. */
const ATTACH_RETRY_MS = 250;
const ATTACH_MAX_RETRIES = 20;

const PREF_KEYS = [
  "readerSelection.enable",
  "readerSelection.color",
  "readerSelection.opacity",
  "readerSelection.tightness",
  "readerSelection.handles",
  "readerSelection.handleColor",
] as const;

// Defaults, used if a pref is unset / wrong-typed.
const DEFAULTS = {
  color: "#8C6FE6",
  opacity: 0.4,
  tightness: 0.72,
  handles: true,
  handleColor: "#2F6BE0",
};

interface SelPrefs {
  color: string;
  opacity: number;
  tightness: number;
  handles: boolean;
  handleColor: string;
}

/** Per-reader live state we hold for cleanup. */
interface ReaderState {
  pdfDoc: Document;
  pdfWin: Window & typeof globalThis;
  styleEl: HTMLStyleElement;
  overlay: HTMLElement;
  onSelectionChange: () => void;
  onPointerUp: () => void;
  rafId: number | null;
  /** Pooled rect nodes, reused across redraws to avoid DOM churn. */
  rectPool: HTMLElement[];
  /** Persistent handle/ball nodes (created lazily). */
  startBar: HTMLElement | null;
  startBall: HTMLElement | null;
  endBar: HTMLElement | null;
  endBall: HTMLElement | null;
  /** Last drawn signature, to skip redundant DOM writes. */
  lastSig: string;
}

function readPrefs(): SelPrefs {
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const str = (v: unknown, d: string) =>
    typeof v === "string" && v ? v : d;
  const clamp = (x: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, x));
  // opacity/tightness are stored as integer PERCENTS (Mozilla prefs can't hold
  // floats safely), so read the percent and convert to a 0..1 fraction here.
  return {
    color: str(getPref("readerSelection.color" as any), DEFAULTS.color),
    opacity: clamp(num(getPref("readerSelection.opacity" as any), 40) / 100, 0, 1),
    tightness: clamp(
      num(getPref("readerSelection.tightness" as any), 72) / 100,
      0.3,
      1,
    ),
    handles: getPref("readerSelection.handles" as any) !== false,
    handleColor: str(
      getPref("readerSelection.handleColor" as any),
      DEFAULTS.handleColor,
    ),
  };
}

function isEnabled(): boolean {
  return getPref("readerSelection.enable" as any) !== false;
}

function addonID(): string {
  try {
    return (addon?.data?.config as any)?.addonID || FALLBACK_ADDON_ID;
  } catch {
    return FALLBACK_ADDON_ID;
  }
}

export class ReaderSelectionFactory {
  private static readonly states = new Map<any, ReaderState>();
  private static prefObserverIDs: symbol[] = [];
  private static readerEventID: string | null = null;
  private static pollTimer: ReturnType<typeof setInterval> | null = null;
  private static registered = false;

  // ----------------------------------------------------------------- lifecycle

  static register(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;

    // Always register the pref observer (even when disabled) so toggling
    // readerSelection.enable on later takes effect via refresh().
    const prefix = (() => {
      try {
        return (
          (addon?.data?.config as any)?.prefsPrefix ||
          "extensions.zotero.zoterostylero"
        );
      } catch {
        return "extensions.zotero.zoterostylero";
      }
    })();
    const onPref = () => {
      if (addon?.data?.alive === false) {
        return;
      }
      this.refresh();
    };
    for (const key of PREF_KEYS) {
      try {
        this.prefObserverIDs.push(
          Zotero.Prefs.registerObserver(`${prefix}.${key}`, onPref, true),
        );
      } catch (e) {
        ztoolkit.log(
          "[Stylero] readerSelection pref observer registration failed",
          key,
          e,
        );
      }
    }

    if (!isEnabled()) {
      return;
    }

    this.attachAll();
    this.registerReaderEvent();
    this.startPoll();
  }

  static unregister(): void {
    this.registered = false;

    // Detach every reader (overlay + style + listeners + rAF).
    for (const reader of [...this.states.keys()]) {
      this.detachReader(reader);
    }
    this.states.clear();

    // Unregister the Reader open event.
    if (this.readerEventID) {
      try {
        (Zotero.Reader as any).unregisterEventListener?.(
          READER_EVENT_TYPE,
          this.readerEventID,
          addonID(),
        );
      } catch (e) {
        ztoolkit.log(
          "[Stylero] readerSelection unregister reader event failed",
          e,
        );
      }
      this.readerEventID = null;
    }

    // Unregister pref observers.
    for (const id of this.prefObserverIDs) {
      try {
        Zotero.Prefs.unregisterObserver(id);
      } catch (e) {
        ztoolkit.log("[Stylero] readerSelection pref unregister failed", e);
      }
    }
    this.prefObserverIDs = [];

    // Stop the fallback poll.
    this.stopPoll();
  }

  static refresh(): void {
    if (!this.registered) {
      return;
    }
    if (!isEnabled()) {
      // Flipped off: detach everything but keep the pref observer alive
      // (register() left it running) so a later flip-on re-attaches.
      for (const reader of [...this.states.keys()]) {
        this.detachReader(reader);
      }
      this.states.clear();
      this.stopPoll();
      if (this.readerEventID) {
        try {
          (Zotero.Reader as any).unregisterEventListener?.(
            READER_EVENT_TYPE,
            this.readerEventID,
            addonID(),
          );
        } catch {
          /* ignore */
        }
        this.readerEventID = null;
      }
      return;
    }

    // Enabled: make sure plumbing is up, then update vars + redraw on each.
    this.registerReaderEvent();
    this.startPoll();
    this.attachAll();

    const prefs = readPrefs();
    for (const [, state] of this.states) {
      try {
        this.applyVars(state, prefs);
        this.scheduleRedraw(state);
      } catch (e) {
        ztoolkit.log("[Stylero] readerSelection refresh redraw failed", e);
      }
    }
  }

  // ------------------------------------------------------------- reader plumbing

  private static registerReaderEvent(): void {
    if (this.readerEventID) {
      return;
    }
    try {
      const handler = (event: any) => {
        try {
          const reader = event?.reader;
          if (reader && reader.type === "pdf") {
            this.attachToReader(reader);
          }
        } catch (e) {
          ztoolkit.log("[Stylero] readerSelection reader-event handler failed", e);
        }
      };
      const id = (Zotero.Reader as any).registerEventListener?.(
        READER_EVENT_TYPE,
        handler,
        addonID(),
      );
      this.readerEventID = id || null;
    } catch (e) {
      ztoolkit.log(
        "[Stylero] readerSelection register reader event failed (falling back to poll)",
        e,
      );
    }
  }

  private static startPoll(): void {
    if (this.pollTimer) {
      return;
    }
    try {
      const mainWin = Zotero.getMainWindow?.();
      const setIv = (mainWin as any)?.setInterval || setInterval;
      this.pollTimer = setIv(() => {
        if (!this.registered || !isEnabled()) {
          return;
        }
        this.attachAll();
      }, POLL_INTERVAL_MS);
    } catch (e) {
      ztoolkit.log("[Stylero] readerSelection poll start failed", e);
    }
  }

  private static stopPoll(): void {
    if (!this.pollTimer) {
      return;
    }
    try {
      const mainWin = Zotero.getMainWindow?.();
      const clearIv = (mainWin as any)?.clearInterval || clearInterval;
      clearIv(this.pollTimer);
    } catch {
      try {
        clearInterval(this.pollTimer as any);
      } catch {
        /* ignore */
      }
    }
    this.pollTimer = null;
  }

  private static attachAll(): void {
    let readers: any[] = [];
    try {
      readers = (Zotero.Reader as any)?._readers || [];
    } catch (e) {
      ztoolkit.log("[Stylero] readerSelection cannot read _readers", e);
      return;
    }
    for (const reader of readers) {
      try {
        if (reader && reader.type === "pdf") {
          this.attachToReader(reader);
        }
      } catch (e) {
        ztoolkit.log("[Stylero] readerSelection attachAll iteration failed", e);
      }
    }
  }

  // ------------------------------------------------------------- attach / detach

  private static attachToReader(reader: any, retry = 0): void {
    if (!reader || reader.type !== "pdf") {
      return;
    }
    // Idempotent: already attached and still alive.
    const existing = this.states.get(reader);
    if (existing) {
      try {
        if (existing.pdfDoc && existing.overlay?.isConnected) {
          return;
        }
      } catch {
        /* fall through to re-attach */
      }
      // Stale state: clean it up and re-attach fresh.
      this.detachReader(reader);
    }

    let pdfDoc: Document | null = null;
    let pdfWin: (Window & typeof globalThis) | null = null;
    try {
      const iframeWin = reader._iframeWindow;
      const innerIframe = iframeWin?.document?.querySelector("iframe");
      pdfDoc = innerIframe?.contentDocument || null;
      pdfWin = (pdfDoc?.defaultView as any) || null;
    } catch (e) {
      ztoolkit.log("[Stylero] readerSelection resolve pdfDoc failed", e);
    }

    // Viewer may still be loading; retry a few times.
    if (!pdfDoc || !pdfWin || !pdfDoc.body) {
      if (retry < ATTACH_MAX_RETRIES) {
        try {
          const w = reader._iframeWindow as any;
          const setT = w?.setTimeout || setTimeout;
          setT(() => {
            try {
              this.attachToReader(reader, retry + 1);
            } catch {
              /* ignore */
            }
          }, ATTACH_RETRY_MS);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    try {
      const prefs = readPrefs();

      // (1) Inject the single <style> (hide native paint + overlay rules).
      let styleEl = pdfDoc.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (!styleEl) {
        styleEl = pdfDoc.createElement("style");
        styleEl.id = STYLE_ID;
        styleEl.textContent = this.styleText();
        const styleHost = pdfDoc.head || pdfDoc.documentElement;
        styleHost?.appendChild(styleEl);
      }

      // (2) The overlay container.
      let overlay = pdfDoc.querySelector(
        `.${OVERLAY_CLASS}`,
      ) as HTMLElement | null;
      if (!overlay) {
        overlay = pdfDoc.createElement("div");
        overlay.className = OVERLAY_CLASS;
        pdfDoc.body.appendChild(overlay);
      }

      const state: ReaderState = {
        pdfDoc,
        pdfWin,
        styleEl,
        overlay,
        onSelectionChange: () => this.scheduleRedraw(state),
        onPointerUp: () => this.scheduleRedraw(state),
        rafId: null,
        rectPool: [],
        startBar: null,
        startBall: null,
        endBar: null,
        endBall: null,
        lastSig: "",
      };

      this.applyVars(state, prefs);

      // (3) Observe-only listeners. No capture, no preventDefault.
      pdfDoc.addEventListener("selectionchange", state.onSelectionChange);
      pdfWin.addEventListener("pointerup", state.onPointerUp);
      pdfWin.addEventListener("mouseup", state.onPointerUp);

      this.states.set(reader, state);
      ztoolkit.log("[Stylero] readerSelection attached to a PDF reader");

      // Draw immediately in case a selection already exists.
      this.scheduleRedraw(state);
    } catch (e) {
      ztoolkit.log("[Stylero] readerSelection attach failed", e);
    }
  }

  private static detachReader(reader: any): void {
    const state = this.states.get(reader);
    if (!state) {
      return;
    }
    try {
      if (state.rafId != null) {
        try {
          (state.pdfWin as any)?.cancelAnimationFrame?.(state.rafId);
        } catch {
          /* ignore */
        }
        state.rafId = null;
      }
      try {
        state.pdfDoc.removeEventListener(
          "selectionchange",
          state.onSelectionChange,
        );
      } catch {
        /* doc gone */
      }
      try {
        state.pdfWin.removeEventListener("pointerup", state.onPointerUp);
        state.pdfWin.removeEventListener("mouseup", state.onPointerUp);
      } catch {
        /* win gone */
      }
      try {
        state.overlay?.remove();
      } catch {
        /* ignore */
      }
      try {
        state.styleEl?.remove();
      } catch {
        /* ignore */
      }
    } catch (e) {
      ztoolkit.log("[Stylero] readerSelection detach failed", e);
    } finally {
      this.states.delete(reader);
    }
  }

  // ---------------------------------------------------------------- style / vars

  private static styleText(): string {
    // (a) Hide native selection paint; (b) overlay/rect/handle/ball styles
    // driven by CSS custom properties so refresh only rewrites the vars.
    return [
      "::selection{background:transparent !important;}",
      ".customAnnotationLayer ::selection{background:transparent !important;}",
      ".textLayer ::selection{background:transparent !important;}",
      `.${OVERLAY_CLASS}{position:fixed;inset:0;pointer-events:none;z-index:2147483646;}`,
      `.${RECT_CLASS}{position:absolute;background:var(--ss-color);opacity:var(--ss-opacity);border-radius:2px;}`,
      `.${HANDLE_CLASS}{position:absolute;width:2px;background:var(--ss-handle);border-radius:1px;}`,
      `.${BALL_CLASS}{position:absolute;width:7px;height:7px;border-radius:50%;background:var(--ss-handle);}`,
    ].join("\n");
  }

  private static applyVars(state: ReaderState, prefs: SelPrefs): void {
    try {
      const o = state.overlay;
      o.style.setProperty("--ss-color", prefs.color);
      o.style.setProperty("--ss-opacity", String(prefs.opacity));
      o.style.setProperty("--ss-handle", prefs.handleColor);
    } catch (e) {
      ztoolkit.log("[Stylero] readerSelection applyVars failed", e);
    }
  }

  // ------------------------------------------------------------------- redraw

  private static scheduleRedraw(state: ReaderState): void {
    try {
      const raf: (cb: () => void) => number =
        (state.pdfWin as any)?.requestAnimationFrame?.bind(state.pdfWin) ||
        ((cb: () => void) => (state.pdfWin as any).setTimeout(cb, 16));
      const tick = () => {
        // Stop the loop once the selection collapses.
        let collapsed = true;
        try {
          const sel = state.pdfWin.getSelection();
          collapsed = !sel || sel.isCollapsed || sel.rangeCount === 0;
        } catch {
          collapsed = true;
        }
        try {
          this.redraw(state);
        } catch (e) {
          ztoolkit.log("[Stylero] readerSelection redraw failed", e);
        }
        if (collapsed) {
          state.rafId = null;
          return;
        }
        // Keep following scroll / zoom while a live selection exists.
        state.rafId = raf(tick);
      };
      // Coalesce: only kick a new frame if one is not already pending.
      if (state.rafId == null) {
        state.rafId = raf(tick);
      }
    } catch (e) {
      ztoolkit.log("[Stylero] readerSelection scheduleRedraw failed", e);
    }
  }

  private static redraw(state: ReaderState): void {
    const { pdfWin, overlay } = state;
    const prefs = readPrefs();

    let sel: Selection | null = null;
    try {
      sel = pdfWin.getSelection();
    } catch {
      sel = null;
    }
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.clearOverlay(state);
      return;
    }

    let rects: DOMRect[] = [];
    try {
      const range = sel.getRangeAt(0);
      const list = range.getClientRects();
      for (let i = 0; list && i < list.length; i++) {
        const r = list[i] as DOMRect;
        if (r && r.width > 0 && r.height > 0) {
          rects.push(r);
        }
      }
    } catch {
      rects = [];
    }
    if (!rects.length) {
      this.clearOverlay(state);
      return;
    }

    // Cheap signature to skip redundant DOM writes (rect count + first/last
    // rounded coords + handle/tightness prefs).
    const first = rects[0];
    const last = rects[rects.length - 1];
    const sig =
      `${rects.length}|${Math.round(first.left)},${Math.round(first.top)},` +
      `${Math.round(first.width)},${Math.round(first.height)}|` +
      `${Math.round(last.left)},${Math.round(last.top)},` +
      `${Math.round(last.width)},${Math.round(last.height)}|` +
      `${prefs.tightness}|${prefs.handles ? 1 : 0}`;
    if (sig === state.lastSig) {
      return;
    }
    state.lastSig = sig;

    const tightness = prefs.tightness;

    // (1) Fill rectangles — reuse pooled nodes.
    let firstTightTop = 0;
    let firstTightH = 0;
    let lastTightTop = 0;
    let lastTightH = 0;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const tightH = r.height * tightness;
      const top = r.top + (r.height - tightH) / 2;

      let node = state.rectPool[i];
      if (!node) {
        node = state.pdfDoc.createElement("div");
        node.className = RECT_CLASS;
        state.rectPool[i] = node;
      }
      if (!node.isConnected) {
        overlay.appendChild(node);
      }
      node.style.display = "";
      node.style.left = `${r.left}px`;
      node.style.top = `${top}px`;
      node.style.width = `${r.width}px`;
      node.style.height = `${tightH}px`;

      if (i === 0) {
        firstTightTop = top;
        firstTightH = tightH;
      }
      if (i === rects.length - 1) {
        lastTightTop = top;
        lastTightH = tightH;
      }
    }
    // Hide any surplus pooled rects from a previous, longer selection.
    for (let i = rects.length; i < state.rectPool.length; i++) {
      const node = state.rectPool[i];
      if (node) node.style.display = "none";
    }

    // (2) End handles (Mendeley-style): start bar at the LEFT edge of the
    // first rect with a ball at its TOP; end bar at the RIGHT edge of the last
    // rect with a ball at its BOTTOM.
    if (prefs.handles) {
      const ext = 3; // extend the bars slightly past the tight rect
      const ballOffset = 3; // centre the 7px ball roughly on the 2px bar
      const firstLeft = first.left;
      const lastRight = last.left + last.width;

      const startBar = this.ensureHandle(state, "startBar", "start", false);
      const startBall = this.ensureHandle(state, "startBall", "start", true);
      const endBar = this.ensureHandle(state, "endBar", "end", false);
      const endBall = this.ensureHandle(state, "endBall", "end", true);

      // Start bar: left edge of first rect.
      startBar.style.display = "";
      startBar.style.left = `${firstLeft}px`;
      startBar.style.top = `${firstTightTop - ext}px`;
      startBar.style.height = `${firstTightH + ext * 2}px`;
      // Ball at the TOP of the start bar.
      startBall.style.display = "";
      startBall.style.left = `${firstLeft - ballOffset}px`;
      startBall.style.top = `${firstTightTop - ext - 7}px`;

      // End bar: right edge of last rect.
      endBar.style.display = "";
      endBar.style.left = `${lastRight}px`;
      endBar.style.top = `${lastTightTop - ext}px`;
      endBar.style.height = `${lastTightH + ext * 2}px`;
      // Ball at the BOTTOM of the end bar.
      endBall.style.display = "";
      endBall.style.left = `${lastRight - ballOffset}px`;
      endBall.style.top = `${lastTightTop + lastTightH + ext}px`;
    } else {
      this.hideHandles(state);
    }
  }

  private static ensureHandle(
    state: ReaderState,
    slot: "startBar" | "startBall" | "endBar" | "endBall",
    side: "start" | "end",
    ball: boolean,
  ): HTMLElement {
    let node = state[slot];
    if (!node) {
      node = state.pdfDoc.createElement("div");
      node.className = ball
        ? `${BALL_CLASS} ${side}`
        : `${HANDLE_CLASS} ${side}`;
      state[slot] = node;
    }
    if (!node.isConnected) {
      state.overlay.appendChild(node);
    }
    return node;
  }

  private static hideHandles(state: ReaderState): void {
    for (const slot of ["startBar", "startBall", "endBar", "endBall"] as const) {
      const node = state[slot];
      if (node) node.style.display = "none";
    }
  }

  private static clearOverlay(state: ReaderState): void {
    state.lastSig = "";
    for (const node of state.rectPool) {
      if (node) node.style.display = "none";
    }
    this.hideHandles(state);
  }
}
