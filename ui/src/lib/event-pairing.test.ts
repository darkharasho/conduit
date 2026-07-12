import { describe, it, expect } from "vitest";
import { reduceEvents } from "./event-pairing";
import type { TesterRow } from "./event-pairing";
import type { WireEvent } from "./client";

// Helper to make WireEvent objects
function pre(
  key_name: string,
  state: "press" | "release" | "repeat",
  time_us: number
): WireEvent {
  return { phase: "pre", key_name, code: 0, state, time_us, device: "" };
}

function post(
  key_name: string,
  state: "press" | "release" | "repeat",
  time_us: number
): WireEvent {
  return { phase: "post", key_name, code: 0, state, time_us, device: "" };
}

describe("reduceEvents — simple remap", () => {
  it("pre press creates a new row", () => {
    const rows = reduceEvents([], pre("a", "press", 1000));
    expect(rows).toHaveLength(1);
    expect(rows[0].pre.name).toBe("a");
    expect(rows[0].pre.state).toBe("press");
    expect(rows[0].pre.timeUs).toBe(1000);
    expect(rows[0].post).toEqual([]);
  });

  it("post event attaches to the open row", () => {
    let rows: TesterRow[] = [];
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, post("b", "press", 1500));
    expect(rows).toHaveLength(1);
    expect(rows[0].post).toHaveLength(1);
    expect(rows[0].post[0].name).toBe("b");
  });

  it("pre release closes the row and computes remap resolution", () => {
    let rows: TesterRow[] = [];
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, post("b", "press", 1200));
    rows = reduceEvents(rows, post("b", "release", 1400));
    rows = reduceEvents(rows, pre("a", "release", 1500));
    expect(rows).toHaveLength(1);
    // post key differs from pre key → "→ b"
    expect(rows[0].resolution).toBe("→ b");
  });

  it("pre release with same key and fast post shows no resolution", () => {
    let rows: TesterRow[] = [];
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, post("a", "press", 1200)); // same key, < 5ms
    rows = reduceEvents(rows, pre("a", "release", 1500));
    // same key, < 5ms delay — no interesting resolution
    expect(rows[0].resolution).toBeUndefined();
  });

  it("post events include release events", () => {
    let rows: TesterRow[] = [];
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, post("b", "press", 1200));
    rows = reduceEvents(rows, post("b", "release", 1400));
    rows = reduceEvents(rows, pre("a", "release", 1600));
    expect(rows[0].post).toHaveLength(2);
    expect(rows[0].post[1].state).toBe("release");
  });
});

describe("reduceEvents — swallowed key", () => {
  it("row with no posts gets (swallowed) resolution on close", () => {
    let rows: TesterRow[] = [];
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, pre("a", "release", 1500));
    expect(rows[0].post).toHaveLength(0);
    expect(rows[0].resolution).toBe("(swallowed)");
  });
});

describe("reduceEvents — tap-hold replay burst", () => {
  it("held key with different post output shows held timing", () => {
    // capslock → tap esc / hold leftctrl
    // Held scenario: pre caps-press, no post yet (buffered), pre caps-release delayed,
    // then post ctrl-press arrives (after >5ms from press)
    let rows: TesterRow[] = [];
    const pressTime = 0;
    const releaseTime = 230_000; // 230ms in us
    const postTime = 235_000;    // 235ms — > 5ms after press

    rows = reduceEvents(rows, pre("capslock", "press", pressTime));
    rows = reduceEvents(rows, pre("capslock", "release", releaseTime));
    rows = reduceEvents(rows, post("leftctrl", "press", postTime));
    rows = reduceEvents(rows, post("leftctrl", "release", postTime + 1000));

    expect(rows).toHaveLength(1);
    // post key differs AND delay > 5ms
    expect(rows[0].resolution).toBe("held 230ms → leftctrl");
  });

  it("post events arriving after pre-release attach by name then balance (per-row distribution)", () => {
    // tap-hold replay burst: pre caps-press, pre a-press (buffered, no post yet),
    // then both pre-releases fire, then posts arrive in a burst.
    // At burst time both rows are closed. Rule 1 (closed name match) routes a↓/a↑
    // to the a row; leftctrl has no name match so it falls to rule 4 (newest = a row).
    // leftctrl↑ then uses rule 2 (unbalanced press) to follow leftctrl↓ → a row.
    let rows: TesterRow[] = [];

    rows = reduceEvents(rows, pre("capslock", "press", 0));
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, pre("capslock", "release", 300_000));
    rows = reduceEvents(rows, pre("a", "release", 301_000));

    // Post burst (both rows are closed at this point)
    rows = reduceEvents(rows, post("leftctrl", "press", 305_000));
    rows = reduceEvents(rows, post("a", "press", 306_000));
    rows = reduceEvents(rows, post("leftctrl", "release", 307_000));
    rows = reduceEvents(rows, post("a", "release", 308_000));

    expect(rows).toHaveLength(2);

    // No posts should be dropped
    const totalPosts = rows.reduce((sum, r) => sum + r.post.length, 0);
    expect(totalPosts).toBe(4);

    // a row gets all 4 posts: leftctrl↓ (rule 4, newest), a↓ (rule 1), leftctrl↑ (rule 2), a↑ (rule 1)
    const aRow = rows.find((r) => r.pre.name === "a")!;
    expect(aRow.post).toHaveLength(4);

    // caps row gets no posts (was closed and pre.name doesn't match any post key)
    const capsRow = rows.find((r) => r.pre.name === "capslock")!;
    expect(capsRow.post).toHaveLength(0);
    expect(capsRow.resolution).toBe("(swallowed)");
  });

  it("tapped key with fast turnaround shows plain remap resolution", () => {
    // Tap: pre caps-press, then immediately post esc-press (< 5ms)
    let rows: TesterRow[] = [];
    rows = reduceEvents(rows, pre("capslock", "press", 0));
    rows = reduceEvents(rows, post("esc", "press", 2_000)); // 2ms, < 5ms threshold
    rows = reduceEvents(rows, post("esc", "release", 3_000));
    rows = reduceEvents(rows, pre("capslock", "release", 4_000));

    expect(rows[0].resolution).toBe("→ esc");
  });
});

describe("reduceEvents — interleaved passthrough typing", () => {
  it("each post attaches to the open row matching its name (rule 1)", () => {
    // Two keys typed quickly: pre a↓, pre b↓, post a↓, post b↓, pre a↑, post a↑, pre b↑, post b↑
    // Rule 1 (open match) routes each post to the correct row.
    let rows: TesterRow[] = [];

    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, pre("b", "press", 1100));
    rows = reduceEvents(rows, post("a", "press", 1200));
    rows = reduceEvents(rows, post("b", "press", 1210));
    rows = reduceEvents(rows, pre("a", "release", 1300));
    rows = reduceEvents(rows, post("a", "release", 1310));
    rows = reduceEvents(rows, pre("b", "release", 1400));
    rows = reduceEvents(rows, post("b", "release", 1410));

    expect(rows).toHaveLength(2);

    const aRow = rows.find((r) => r.pre.name === "a")!;
    const bRow = rows.find((r) => r.pre.name === "b")!;

    // a row gets only a's posts
    expect(aRow.post.map((p) => p.name)).toEqual(["a", "a"]);
    expect(aRow.post[0].state).toBe("press");
    expect(aRow.post[1].state).toBe("release");
    // passthrough — no resolution string
    expect(aRow.resolution).toBeUndefined();

    // b row gets only b's posts
    expect(bRow.post.map((p) => p.name)).toEqual(["b", "b"]);
    expect(bRow.post[0].state).toBe("press");
    expect(bRow.post[1].state).toBe("release");
    expect(bRow.resolution).toBeUndefined();
  });
});

describe("reduceEvents — permissive-hold burst (caps open during burst)", () => {
  it("ctrl↓ goes to caps row (rule 3 oldest open no-post), a↓/a↑ go to a row (rule 1 closed), ctrl↑ balances (rule 2)", () => {
    // Sequence: pre caps↓, pre a↓, pre a↑ → burst [ctrl↓, a↓, a↑], later pre caps↑ → post ctrl↑
    // At burst time: caps row is OPEN with no posts; a row is CLOSED.
    let rows: TesterRow[] = [];

    rows = reduceEvents(rows, pre("capslock", "press", 0));
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, pre("a", "release", 1200));

    // Burst: caps is still open, a is closed
    rows = reduceEvents(rows, post("leftctrl", "press", 2000));  // rule 3 → caps (oldest open, no posts)
    rows = reduceEvents(rows, post("a", "press", 2010));          // rule 1 closed → a row
    rows = reduceEvents(rows, post("a", "release", 2020));        // rule 1 closed → a row

    // caps pre-release arrives, then post ctrl↑
    rows = reduceEvents(rows, pre("capslock", "release", 300_000));
    rows = reduceEvents(rows, post("leftctrl", "release", 300_500)); // rule 2 → caps (has unbalanced ctrl↓)

    expect(rows).toHaveLength(2);

    const capsRow = rows.find((r) => r.pre.name === "capslock")!;
    const aRow = rows.find((r) => r.pre.name === "a")!;

    // caps row: ctrl↓ and ctrl↑
    expect(capsRow.post).toHaveLength(2);
    expect(capsRow.post[0]).toMatchObject({ name: "leftctrl", state: "press" });
    expect(capsRow.post[1]).toMatchObject({ name: "leftctrl", state: "release" });
    // first post name ≠ pre name → held resolution (300ms > 5ms threshold)
    expect(capsRow.resolution).toMatch(/^held \d+ms → leftctrl$/);

    // a row: a↓ and a↑ only
    expect(aRow.post).toHaveLength(2);
    expect(aRow.post[0]).toMatchObject({ name: "a", state: "press" });
    expect(aRow.post[1]).toMatchObject({ name: "a", state: "release" });
    // passthrough
    expect(aRow.resolution).toBeUndefined();
  });
});

describe("reduceEvents — repeat counting", () => {
  it("pre repeat events increment repeats counter, not new rows", () => {
    let rows: TesterRow[] = [];
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, pre("a", "repeat", 1100));
    rows = reduceEvents(rows, pre("a", "repeat", 1200));
    rows = reduceEvents(rows, pre("a", "repeat", 1300));
    rows = reduceEvents(rows, pre("a", "release", 1400));

    expect(rows).toHaveLength(1);
    expect(rows[0].repeats).toBe(3);
  });

  it("repeat on a key with no open row creates no new row", () => {
    // repeat with no prior press — should be ignored gracefully
    let rows: TesterRow[] = [];
    rows = reduceEvents(rows, pre("a", "repeat", 1000));
    expect(rows).toHaveLength(0);
  });
});

describe("reduceEvents — id stability", () => {
  it("ids are monotonically increasing integers, no Date.now()", () => {
    let rows: TesterRow[] = [];
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, pre("a", "release", 1100));
    rows = reduceEvents(rows, pre("b", "press", 1200));
    rows = reduceEvents(rows, pre("b", "release", 1300));
    rows = reduceEvents(rows, pre("c", "press", 1400));
    rows = reduceEvents(rows, pre("c", "release", 1500));

    expect(rows[0].id).toBe(1);
    expect(rows[1].id).toBe(2);
    expect(rows[2].id).toBe(3);
  });

  it("ids keep incrementing when window is trimmed", () => {
    let rows: TesterRow[] = [];
    // Create 101 rows
    for (let i = 0; i < 101; i++) {
      rows = reduceEvents(rows, pre("a", "press", i * 1000));
      rows = reduceEvents(rows, pre("a", "release", i * 1000 + 500));
    }
    expect(rows).toHaveLength(100);
    // The newest row should have id 101, oldest should have id 2
    const ids = rows.map((r) => r.id);
    expect(ids[ids.length - 1]).toBe(101);
    expect(ids[0]).toBe(2);
  });
});

describe("reduceEvents — rolling window", () => {
  it("trims to last 100 rows", () => {
    let rows: TesterRow[] = [];
    for (let i = 0; i < 110; i++) {
      rows = reduceEvents(rows, pre("a", "press", i * 1000));
      rows = reduceEvents(rows, pre("a", "release", i * 1000 + 500));
    }
    expect(rows).toHaveLength(100);
  });

  it("post events on open rows are never dropped when trimming", () => {
    // Create 99 closed rows, then 1 open row with a pending post
    let rows: TesterRow[] = [];
    for (let i = 0; i < 99; i++) {
      rows = reduceEvents(rows, pre("a", "press", i * 2000));
      rows = reduceEvents(rows, pre("a", "release", i * 2000 + 500));
    }
    // Open a new row
    rows = reduceEvents(rows, pre("b", "press", 200_000));
    // Attach a post to it
    rows = reduceEvents(rows, post("c", "press", 200_500));

    expect(rows).toHaveLength(100);
    // Last row should be the open 'b' row with 'c' post
    const last = rows[rows.length - 1];
    expect(last.pre.name).toBe("b");
    expect(last.post[0].name).toBe("c");
  });
});

describe("reduceEvents — multiple rows", () => {
  it("passthrough post attaches to open row with matching name (rule 1 open)", () => {
    let rows: TesterRow[] = [];
    // Open two rows
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, pre("b", "press", 2000));

    // post("b") should go to the open row whose pre.name === "b" (rule 1)
    rows = reduceEvents(rows, post("b", "press", 2500));

    expect(rows).toHaveLength(2);
    expect(rows[0].post).toHaveLength(0); // a row has no posts
    expect(rows[1].post).toHaveLength(1); // b row has the matching post
    expect(rows[1].post[0].name).toBe("b");
  });

  it("unrecognised post key goes to oldest open row with no posts (rule 3)", () => {
    let rows: TesterRow[] = [];
    // Open two rows
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, pre("b", "press", 2000));

    // post("x") has no name match → rule 3: oldest open with no posts = a
    rows = reduceEvents(rows, post("x", "press", 2500));

    expect(rows).toHaveLength(2);
    expect(rows[0].post).toHaveLength(1); // a row gets the post (oldest open, no posts)
    expect(rows[0].post[0].name).toBe("x");
    expect(rows[1].post).toHaveLength(0); // b row untouched
  });
});
