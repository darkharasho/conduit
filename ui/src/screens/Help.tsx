import { useState } from "react";
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
  return (
    <div className="help">
      <div className="help__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`help__tab${tab === t.id ? " help__tab--sel" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="help__body">
        {tab === "tester" && <KeyTesterScreen />}
        {tab === "engine" && <StatusScreen />}
        {tab === "hardware" && <DevicesScreen />}
      </div>
    </div>
  );
}
