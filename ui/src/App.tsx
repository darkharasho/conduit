import { useState } from "react";
import { StatusScreen } from "./screens/Status";
import { MappingsScreen } from "./screens/Mappings";
import { KeyTesterScreen } from "./screens/KeyTester";

type Screen = "mappings" | "key-tester" | "devices" | "status";

const NAV_ITEMS: { id: Screen; label: string }[] = [
  { id: "mappings", label: "Mappings" },
  { id: "key-tester", label: "Key Tester" },
  { id: "devices", label: "Devices" },
  { id: "status", label: "Status" },
];

function PlaceholderScreen({ title }: { title: string }) {
  return (
    <div className="screen placeholder-screen">
      <h2 className="screen__title">{title}</h2>
      <p className="muted">Coming soon.</p>
    </div>
  );
}

function App() {
  const [activeScreen, setActiveScreen] = useState<Screen>("status");

  function renderScreen() {
    switch (activeScreen) {
      case "status":
        return <StatusScreen />;
      case "mappings":
        return <MappingsScreen />;
      case "key-tester":
        return <KeyTesterScreen />;
      case "devices":
        return <PlaceholderScreen title="Devices" />;
    }
  }

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Main navigation">
        <div className="sidebar__brand">Conduit</div>
        <ul className="sidebar__nav">
          {NAV_ITEMS.map((item) => (
            <li key={item.id}>
              <button
                className={`sidebar__nav-item${
                  activeScreen === item.id
                    ? " sidebar__nav-item--active"
                    : ""
                }`}
                onClick={() => setActiveScreen(item.id)}
                aria-current={activeScreen === item.id ? "page" : undefined}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="main-content">{renderScreen()}</main>
    </div>
  );
}

export default App;
