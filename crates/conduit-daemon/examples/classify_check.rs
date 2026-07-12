fn main() {
    for d in conduit_daemon::devices::discover().unwrap() {
        println!("{:<9} {:<28} {}", d.class.as_str(), d.id(), d.path.display());
    }
}
