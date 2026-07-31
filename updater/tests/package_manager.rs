use factory_update_manager::builder::PackageFormat;
use factory_update_manager::package_manager::factory_version_from_package_version;

#[test]
fn deb_wrapper_revision_normalizes_to_the_factory_version() {
    assert_eq!(
        factory_version_from_package_version(PackageFormat::Deb, "0.142.0-5").unwrap(),
        "0.142.0"
    );
    assert_eq!(
        factory_version_from_package_version(PackageFormat::Deb, "0.143.0").unwrap(),
        "0.143.0"
    );
}

#[test]
fn rpm_package_version_is_already_the_factory_version() {
    assert_eq!(
        factory_version_from_package_version(PackageFormat::Rpm, "0.142.0").unwrap(),
        "0.142.0"
    );
}

#[test]
fn malformed_package_versions_fail_closed() {
    for (format, version) in [
        (PackageFormat::Deb, "0.142-5"),
        (PackageFormat::Deb, "0.142.0-0"),
        (PackageFormat::Deb, "1:0.142.0-5"),
        (PackageFormat::Rpm, "0.142.0-5"),
    ] {
        assert!(factory_version_from_package_version(format, version).is_err());
    }
}
