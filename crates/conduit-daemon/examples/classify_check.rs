fn main() {
    for d in conduit_daemon::devices::discover().unwrap() {
        println!(
            "{:<9} {:<40} keys={:<3} wheel={}{} {}",
            d.class.as_str(),
            d.id(),
            d.keys.len(),
            if d.wheel { "v" } else { "-" },
            if d.hwheel { "h" } else { "-" },
            d.path.display()
        );
    }
}
