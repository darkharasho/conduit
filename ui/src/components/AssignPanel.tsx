import { useState } from "react";
import type { ActionModel, ConfigModel } from "../lib/config-model";
import { actionLabel, keyDisplayName } from "../lib/action-labels";
import {
  searchCatalog,
  popularEntries,
  entriesFor,
  parseComboInput,
  entryForAction,
  chordLabel,
} from "../lib/action-catalog";
import type { CatalogCategory, CatalogEntry } from "../lib/action-catalog";
import { captureNextKey } from "../lib/client";
import { InspectorPanel } from "./InspectorPanel";

interface Props {
  keyName: string;
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  /** Effective current action (device override or profile); null = unmapped */
  currentAction: ActionModel | null;
  /** TOML echo passed through to the advanced editor */
  tomlEcho: string | null;
  onSave: (action: ActionModel) => Promise<void>;
  /** "Use default": remove the mapping so the button does its normal job */
  onUseDefault: () => Promise<void>;
  onClose: () => void;
  /**
   * When set, the panel is in app-context mode: shows an eyebrow "In {label}"
   * above the key name and changes the first footer hatch to
   * "Use the Everywhere setting (everywhereLabel)" or "Use the Everywhere setting"
   * when everywhereLabel is null.
   */
  appContext?: { label: string; everywhereLabel: string | null };
}

type Category = "popular" | CatalogCategory;

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "popular", label: "Popular" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "keys", label: "Keys" },
  { id: "media", label: "Media & volume" },
  { id: "system", label: "System" },
];

/**
 * Search-first assignment panel: catalog entries are the primary path,
 * the press-to-set capture flow lives inside the "Keys" category,
 * and the old kind-based editor stays available behind the quiet advanced link.
 */
export function AssignPanel({
  keyName,
  model,
  activeProfile,
  activeLayer,
  currentAction,
  tomlEcho,
  onSave,
  onUseDefault,
  onClose,
  appContext,
}: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("popular");
  const [capturing, setCapturing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCapture = () =>
    run(async () => {
      setCapturing(true);
      try {
        const captured = await captureNextKey();
        await onSave({ kind: "key", key: captured.name });
      } finally {
        setCapturing(false);
      }
    });

  const save = (action: ActionModel) => run(() => onSave(action));

  // Build the list of entries to display
  const comboAction = query ? parseComboInput(query) : null;
  // When a typed combo resolves to a catalog entry, include it in results so the
  // user sees the named action (e.g. "Undo" for "ctrl+z") even if the text
  // search wouldn't match the formatted subtitle ("Ctrl + Z" vs "ctrl+z").
  const comboEntry: CatalogEntry | null = comboAction ? entryForAction(comboAction) : null;
  const catalogResults = query ? searchCatalog(query) : [];
  // Merge: text results first, then the combo-matched entry if not already present
  const mergedResults: CatalogEntry[] = comboEntry
    ? catalogResults.some((e) => e.id === comboEntry.id)
      ? catalogResults
      : [...catalogResults, comboEntry]
    : catalogResults;
  const displayEntries = query
    ? mergedResults
    : category === "popular"
      ? popularEntries()
      : entriesFor(category as CatalogCategory);

  if (advanced) {
    return (
      <div className="assign" role="region" aria-label={`Assign ${keyDisplayName(keyName)}`}>
        <button className="assign__back" onClick={() => setAdvanced(false)}>
          ‹ Back to simple options
        </button>
        <InspectorPanel
          keyName={keyName}
          model={model}
          activeProfile={activeProfile}
          activeLayer={activeLayer}
          tomlEcho={tomlEcho}
          onSave={onSave}
          onClose={onClose}
        />
      </div>
    );
  }

  // Footer hatch label depends on whether we're in app context
  const defaultHatchLabel = appContext
    ? `Use the Everywhere setting${appContext.everywhereLabel ? ` (${appContext.everywhereLabel})` : ""}`
    : "Use the button's normal behavior";

  return (
    <div className="assign" role="region" aria-label={`Assign ${keyDisplayName(keyName)}`}>
      <div className="assign__head">
        <div>
          {appContext && (
            <p className="assign__eyebrow">In {appContext.label}</p>
          )}
          <h2 className="assign__title">{keyDisplayName(keyName)}</h2>
          <p className="assign__now">
            Right now it does:{" "}
            <span className="assign__now-val">{actionLabel(currentAction)}</span>
          </p>
        </div>
        <button className="modal__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {/* Search input */}
      <div className="assign-search">
        <input
          type="text"
          placeholder='Search anything — "screenshot", "ctrl+z", "mute"…'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* Category chips — only shown when not searching */}
      {!query && (
        <div className="assign-cats">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              className={`assign-cat${category === cat.id ? " assign-cat--sel" : ""}`}
              onClick={() => setCategory(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>
      )}

      {/* Entry list */}
      <div className="assign__list">
        {/* Press-to-set row: only in Keys category (or search) */}
        {!query && category === "keys" && (
          <button
            className="cat-row"
            onClick={handleCapture}
            disabled={capturing || busy}
          >
            <div className="cat-row__label">
              {capturing ? "Press any key…" : "Press a key to type it…"}
            </div>
            <div className="cat-row__sub">
              {capturing
                ? "Waiting for the key this button should type"
                : "Click, then press the physical key"}
            </div>
          </button>
        )}

        {displayEntries.map((entry) => (
          <button
            key={entry.id}
            className="cat-row"
            disabled={busy}
            onClick={() => save(entry.action)}
          >
            <div className="cat-row__label">{entry.label}</div>
            <div className="cat-row__sub">{entry.subtitle}</div>
          </button>
        ))}

        {/* Synthetic row for typed combo */}
        {comboAction && comboAction.kind === "chord" && (
          <button
            className="cat-row"
            disabled={busy}
            onClick={() => save(comboAction)}
          >
            <div className="cat-row__label">
              Press {chordLabel(comboAction.keys)}
            </div>
            <div className="cat-row__sub">Custom shortcut</div>
          </button>
        )}
      </div>

      {error && (
        <div className="inspector__error" role="alert">
          {error}
        </div>
      )}

      {/* Footer */}
      <div className="assign__foot">
        <button
          className="assign__default"
          disabled={busy}
          onClick={() => run(onUseDefault)}
        >
          {defaultHatchLabel}
        </button>
        <button
          className="assign__disable"
          disabled={busy}
          onClick={() => save({ kind: "disabled" })}
        >
          Do nothing when pressed
        </button>
      </div>

      <button
        className="assign-adv-link"
        onClick={() => setAdvanced(true)}
      >
        Advanced: tap &amp; hold, layers… ›
      </button>
    </div>
  );
}
