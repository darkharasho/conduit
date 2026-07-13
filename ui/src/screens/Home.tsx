import { useCallback, useEffect, useState } from "react";
import { DeviceArt } from "../components/DeviceArt";
import { ConduitError, listDevices, type DeviceInfo } from "../lib/client";
import type { ConfigModel } from "../lib/config-model";
import {
  appProfileCount,
  deviceOverrideCount,
  groupPhysicalDevices,
  rememberedDevices,
  type PhysicalDevice,
} from "../lib/device-registry";
import { presentError, type ErrorPresentation } from "../lib/error-messages";

interface Props {
  model: ConfigModel | null;
  connected: boolean | null;
  onOpenDevice: (d: PhysicalDevice) => void;
}

function investmentLine(model: ConfigModel | null, phys: PhysicalDevice): string {
  if (!model) return "";
  const overrides = deviceOverrideCount(model, phys);
  const apps = appProfileCount(model);
  const parts: string[] = [];
  if (overrides > 0) parts.push(`${overrides} button${overrides === 1 ? "" : "s"} set just for this device`);
  if (apps > 0) parts.push(`custom in ${apps} app${apps === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "Using normal behavior";
}

export function HomeScreen({ model, connected, onOpenDevice }: Props) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<ErrorPresentation | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    listDevices()
      .then((d) => setDevices(d))
      .catch((e: unknown) => {
        setDevices([]);
        setError(presentError(e instanceof ConduitError ? e : new ConduitError("unknown", String(e))));
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, connected]);

  const phys = groupPhysicalDevices(devices ?? []);
  const remembered = model ? rememberedDevices(model, devices ?? []) : [];
  const loaded = devices !== null;

  return (
    <div className="home">
      <h1 className="home__title">Your devices</h1>
      <div className="home__sub">Click a device to change what its buttons do.</div>

      {error && (
        <div className="home__error" role="alert">
          <div className="home__error-title">{error.title}</div>
          <div className="home__error-body">{error.body}</div>
          {error.action === "retry" && (
            <button className="btn" onClick={refresh}>Try again</button>
          )}
        </div>
      )}

      {loaded && !error && phys.length === 0 && (
        <div className="home__empty">
          <DeviceArt archetype="mouse" width={72} />
          <div className="home__empty-text">Plug in a mouse or keyboard to get started</div>
        </div>
      )}

      <div className="home__grid">
        {phys.map((d) => (
          <button key={d.key} className="device-card" onClick={() => onOpenDevice(d)}>
            <span className="device-card__art"><DeviceArt archetype={d.archetype} /></span>
            <span className="device-card__info">
              <span className="device-card__name">{d.name}</span>
              <span className="device-card__state">
                <span className={`device-card__dot${connected === true ? " device-card__dot--ok" : ""}`} />
                {connected === true ? "Working" : "Waiting for Conduit's engine"}
              </span>
              <span className="device-card__meta">{investmentLine(model, d)}</span>
            </span>
            <span className="device-card__chev" aria-hidden>›</span>
          </button>
        ))}
      </div>

      {remembered.length > 0 && (
        <div className="home__remembered">
          <h2 className="home__remembered-title">Remembered devices</h2>
          {remembered.map((r) => (
            <div key={r.selector} className="remembered-row">
              <span className="device-art--dim"><DeviceArt archetype={r.archetype} width={26} /></span>
              <span>
                <span className="remembered-row__name">{r.name} — not connected</span>
                <span className="remembered-row__note">Its settings are saved and will come back when you plug it in.</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
