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
  return { phase: "pre", key_name, code: 0, state, time_us };
}

function post(
  key_name: string,
  state: "press" | "release" | "repeat",
  time_us: number
): WireEvent {
  return { phase: "post", key_name, code: 0, state, time_us };
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

  it("post events arriving after pre-release attach to the most recent row", () => {
    // tap-hold replay burst: pre caps-press, pre a-press (buffered, no post yet),
    // then posts ctrl-press and a-press arrive after resolution
    let rows: TesterRow[] = [];

    // caps-press
    rows = reduceEvents(rows, pre("capslock", "press", 0));
    // a-press buffered (caps is still open)
    rows = reduceEvents(rows, pre("a", "press", 1000));

    // Now resolution fires: caps-release, a-release
    rows = reduceEvents(rows, pre("capslock", "release", 300_000));
    rows = reduceEvents(rows, pre("a", "release", 301_000));

    // Post events arrive in a burst (replay)
    rows = reduceEvents(rows, post("leftctrl", "press", 305_000));
    rows = reduceEvents(rows, post("a", "press", 306_000));
    rows = reduceEvents(rows, post("leftctrl", "release", 307_000));
    rows = reduceEvents(rows, post("a", "release", 308_000));

    // Should have 2 rows (caps and a)
    expect(rows).toHaveLength(2);

    // The post events should have attached to a row (no posts dropped)
    const totalPosts = rows.reduce((sum, r) => sum + r.post.length, 0);
    expect(totalPosts).toBe(4);
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
  it("posts attach to the most recent open row", () => {
    let rows: TesterRow[] = [];
    // Open two rows
    rows = reduceEvents(rows, pre("a", "press", 1000));
    rows = reduceEvents(rows, pre("b", "press", 2000));

    // Post should go to the most recent open row (b)
    rows = reduceEvents(rows, post("x", "press", 2500));

    expect(rows).toHaveLength(2);
    expect(rows[0].post).toHaveLength(0); // a row has no posts
    expect(rows[1].post).toHaveLength(1); // b row has the post
    expect(rows[1].post[0].name).toBe("x");
  });
});
