import type { ConfigModel, DeviceIdent } from "../lib/config-model";
import { getEffectiveAction } from "../lib/config-model";
import type { DeviceLayout } from "../lib/mouse-layouts";
import { actionHint } from "./KeyboardViz";

interface Props {
  layout: DeviceLayout;
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  selectedKey: string | null;
  onSelectKey: (keyName: string) => void;
  dev: DeviceIdent | null;
}

/**
 * Renders a hand-curated device layout (see lib/mouse-layouts.ts): grouped,
 * properly named controls. Onboard-only controls (`key: null`) render as
 * informational chips — they emit nothing, so they can't be mapped.
 */
export function CuratedLayout({
  layout,
  model,
  activeProfile,
  activeLayer,
  selectedKey,
  onSelectKey,
  dev,
}: Props) {
  return (
    <div className="curated" aria-label={layout.title}>
      <div className="curated__title">{layout.title}</div>
      <div className="curated__groups">
        {layout.groups.map((group) => (
          <div key={group.label}>
            <div className="mouse-viz__group-label">{group.label}</div>
            <div className="mouse-viz__chips">
              {group.buttons.map((b) => {
                if (b.key === null) {
                  return (
                    <span
                      key={b.label}
                      className="mousekey mousekey--onboard"
                      title={b.note ?? "Handled by onboard firmware; emits nothing."}
                    >
                      <span className="mousekey__label">{b.label}</span>
                      <i className="mousekey__action">onboard</i>
                    </span>
                  );
                }
                const eff = getEffectiveAction(model, activeProfile, dev, activeLayer, b.key);
                const hint = actionHint(eff?.action ?? null);
                const isSelected = b.key === selectedKey;
                return (
                  <button
                    key={b.label}
                    data-key={b.key}
                    className={[
                      "mousekey",
                      eff ? "mousekey--mapped" : "",
                      eff?.source === "device" ? "mousekey--devspec" : "",
                      isSelected ? "mousekey--sel" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => onSelectKey(b.key!)}
                    title={b.note ?? b.key}
                    aria-pressed={isSelected}
                  >
                    <span className="mousekey__label">{b.label}</span>
                    <i className="mousekey__action">{hint || b.key}</i>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
