import { useRef, useState } from "react";
import { DevicesScreen } from "./Devices";
import { KeyTesterScreen } from "./KeyTester";
import { StatusScreen } from "./Status";

type Tab = "tester" | "engine" | "hardware";

const TABS: { id: Tab; label: string }[] = [
  { id: "tester", label: "Is Conduit seeing your presses?" },
  { id: "engine", label: "Engine details" },
  { id: "hardware", label: "All hardware" },
];

export function HelpScreen() {
  const [tab, setTab] = useState<Tab>("tester");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    let next = index;
    if (e.key === "ArrowRight") {
      next = (index + 1) % TABS.length;
    } else if (e.key === "ArrowLeft") {
      next = (index - 1 + TABS.length) % TABS.length;
    } else {
      return;
    }
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="help">
      <div className="help__tabs" role="tablist">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`help-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`help-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`help__tab${tab === t.id ? " help__tab--sel" : ""}`}
            ref={(el) => { tabRefs.current[i] = el; }}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => handleKeyDown(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`help-panel-${tab}`}
        aria-labelledby={`help-tab-${tab}`}
        className="help__body"
      >
        {tab === "tester" && <KeyTesterScreen />}
        {tab === "engine" && <StatusScreen />}
        {tab === "hardware" && <DevicesScreen />}
      </div>
    </div>
  );
}
