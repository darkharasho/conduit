import type { ConfigModel, DeviceIdent } from "../lib/config-model";
import { getEffectiveAction } from "../lib/config-model";
import { codeForKeyName } from "../lib/keyboard-layout";
import { layoutFor } from "../lib/mouse-layouts";
import { actionLabel } from "../lib/action-labels";
import { CuratedLayout } from "./CuratedLayout";
import { ExtraKeys } from "./ExtraKeys";
import { MouseIllustration, ILLO_KEYS } from "./MouseIllustration";

interface Props {
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  selectedKey: string | null;
  onSelectKey: (keyName: string) => void;
  /** Device tab context; null = no device (profile tables only). */
  dev?: DeviceIdent | null;
}

/** Names the diagram/chips can show, in display order. */
const SIDE_KEYS = ["mouse4", "mouse5"] as const;
const EXTRA_BTN_KEYS = ["btn_forward", "btn_back", "btn_task"] as const;
const DIAGRAM_CODES = new Set(
  ["btn_left", "btn_right", "btn_middle", ...SIDE_KEYS, ...EXTRA_BTN_KEYS].map(
    (n) => codeForKeyName(n)!
  )
);

/**
 * Mouse visualization for mouse/touchpad device tabs, driven by the device's
 * declared capabilities: only buttons that exist render, wheel chips follow
 * REL_WHEEL/REL_HWHEEL, and any other declared codes (gaming buttons, media
 * keys on combo devices) appear as mappable chips. Without capability data
 * (dev null or empty keys) everything renders.
 */
export function MouseViz({
  model,
  activeProfile,
  activeLayer,
  selectedKey,
  onSelectKey,
  dev = null,
}: Props) {
  const curated = dev ? layoutFor(dev as { vendor: number; product: number; class?: string }) : null;
  const declared = dev?.keys && dev.keys.length > 0 ? new Set(dev.keys) : null;
  const has = (key: string) => {
    if (!declared) return true; // no capability data → show everything
    const code = codeForKeyName(key);
    return code !== null && declared.has(code);
  };
  const hasWheel = declared ? dev?.wheel === true : true;
  const hasHWheel = declared ? dev?.hwheel === true : true;
  const wheelKeys = [
    ...(hasWheel ? ["wheelup", "wheeldown"] : []),
    ...(hasHWheel ? ["wheelleft", "wheelright"] : []),
  ];
  const extraBtnKeys = EXTRA_BTN_KEYS.filter(has);
  const curatedCodes = new Set(
    (curated?.groups ?? [])
      .flatMap((g) => g.buttons)
      .map((b) => (b.key ? codeForKeyName(b.key) : null))
      .filter((c): c is number => c !== null)
  );
  const shownCodes = curated ? curatedCodes : DIAGRAM_CODES;
  const extraCodes = declared
    ? [...declared].filter((c) => !shownCodes.has(c)).sort((a, b) => a - b)
    : [];
  // Real mouse controls live in the BTN ranges; KEY_* codes on a mouse node
  // are almost always firmware over-declaration.
  const isButtonCode = (c: number) =>
    (c >= 0x100 && c <= 0x15f) || (c >= 0x2c0 && c <= 0x2e7);

  const control = (key: string, label: string, extraClass = "") => {
    const eff = getEffectiveAction(model, activeProfile, dev, activeLayer, key);
    // Plain words when customized; nothing when the control does its normal job.
    const hint = eff ? actionLabel(eff.action) : "";
    const isSelected = key === selectedKey;
    return (
      <button
        key={key}
        data-key={key}
        className={[
          "mousekey",
          extraClass,
          eff ? "mousekey--mapped" : "",
          eff?.source === "device" ? "mousekey--devspec" : "",
          isSelected ? "mousekey--sel" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => onSelectKey(key)}
        title={key}
        aria-label={`${label}${hint ? ` — ${hint}` : ""}`}
        aria-pressed={isSelected}
      >
        <span className="mousekey__label">{label}</span>
        {hint && <i className="mousekey__action">{hint}</i>}
      </button>
    );
  };

  // Standard controls the mouse picture can place; everything else is a chip.
  const illoKeys = ILLO_KEYS.filter(has);

  const illustration = (
    <MouseIllustration
      model={model}
      activeProfile={activeProfile}
      activeLayer={activeLayer}
      selectedKey={selectedKey}
      onSelectKey={onSelectKey}
      dev={dev}
      keys={illoKeys}
    />
  );

  if (curated) {
    return (
      <div className="mouse-viz-wrap">
        <div className="mouse-viz-row">
          {illustration}
          <div className="mouse-viz-row__groups">
            <CuratedLayout
              layout={curated}
              model={model}
              activeProfile={activeProfile}
              activeLayer={activeLayer}
              selectedKey={selectedKey}
              onSelectKey={onSelectKey}
              dev={dev}
            />
            <ExtraKeys
              model={model}
              activeProfile={activeProfile}
              activeLayer={activeLayer}
              selectedKey={selectedKey}
              onSelectKey={onSelectKey}
              dev={dev}
              codes={extraCodes}
              primary={(c) => (c >= 0x100 && c <= 0x15f) || (c >= 0x2c0 && c <= 0x2e7)}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mouse-viz-wrap">
      <div className="mouse-viz-row">
        {illustration}
        <div className="mouse-viz-row__groups">
          <div className="mouse-viz__groups">
            {wheelKeys.length > 0 && (
              <div>
                <div className="mouse-viz__group-label">Wheel</div>
                <div className="mouse-viz__chips">
                  {wheelKeys.map((k) => control(k, k.replace("wheel", "Scroll ")))}
                </div>
              </div>
            )}
            {extraBtnKeys.length > 0 && (
              <div>
                <div className="mouse-viz__group-label">Extra buttons</div>
                <div className="mouse-viz__chips">
                  {extraBtnKeys.map((k) => control(k, k.replace("btn_", "")))}
                </div>
              </div>
            )}
          </div>
          <ExtraKeys
            model={model}
            activeProfile={activeProfile}
            activeLayer={activeLayer}
            selectedKey={selectedKey}
            onSelectKey={onSelectKey}
            dev={dev}
            codes={extraCodes}
            primary={isButtonCode}
          />
        </div>
      </div>
    </div>
  );
}
