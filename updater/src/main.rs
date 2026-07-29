fn main() {
    eprintln!(
        "factory-update-manager is not implemented yet; Phase 4 will add a fail-closed updater"
    );
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    #[test]
    fn phase_zero_binary_is_not_a_fake_success() {
        assert_eq!(2, 2);
    }
}
