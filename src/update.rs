//! Checking GitHub for a newer Lyra PoS, and opening its download page.
//!
//! The screens never touch the network. This module does the one request the
//! app ever makes on its own — the latest published release — and the person in
//! the shop decides whether to do anything about it. With the check switched
//! off in Setup, nothing here runs at all.
//!
//! The request is deliberately small: the GitHub release JSON is a few KB and
//! is read only for its version, notes and asset links. Nothing about the shop
//! (its name, sales or settings) is sent, and the app keeps working exactly as
//! it did if the machine has no internet.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The public repository whose releases are the app's updates.
const RELEASES_API: &str =
    "https://api.github.com/repos/shahittoshariear-spec/Lyra-PoS/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/shahittoshariear-spec/Lyra-PoS/releases";
const USER_AGENT: &str = "Lyra-PoS-update-check";

/// What the screens are told about the latest release. Shaped for the IPC
/// boundary, so the front end never sees GitHub's own JSON.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    /// The latest release's version, without its leading `v`.
    pub version: String,
    /// True only when the latest release is newer than this app.
    pub available: bool,
    pub name: String,
    pub notes: String,
    pub page_url: String,
    /// The setup installer when the release carries one, otherwise the release
    /// page. Opening it is the only action the app takes.
    pub download_url: String,
    pub published_at: String,
}

#[derive(Deserialize)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
}

/// Fetches the latest release and compares it with this app.
///
/// Runs on a worker thread: a shop with a slow or missing connection must not
/// wait on it. The overall deadline is short, because an update check is never
/// worth holding a till up for.
pub fn check(current_version: &str) -> Result<UpdateInfo, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .build()
        .into();

    let mut response = agent
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;

    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("GitHub's answer could not be read: {e}"))?;

    let release: Release = serde_json::from_str(&body)
        .map_err(|e| format!("GitHub's answer was not a release: {e}"))?;

    let version = release.tag_name.trim().trim_start_matches('v').to_string();
    if version.is_empty() {
        return Err("GitHub returned a release with no version.".to_string());
    }

    let download_url =
        pick_download(&release.assets).unwrap_or_else(|| page_or_releases(&release.html_url));

    Ok(UpdateInfo {
        current_version: current_version.trim().trim_start_matches('v').to_string(),
        available: is_newer(&version, current_version),
        version,
        name: release.name.trim().to_string(),
        notes: release.body.trim().to_string(),
        page_url: page_or_releases(&release.html_url),
        download_url,
        published_at: release.published_at,
    })
}

/// The setup installer is the one a shop should double-click. The portable
/// build is a good second choice; the release page is the fallback that can
/// never be missing.
fn pick_download(assets: &[Asset]) -> Option<String> {
    let usable = |a: &&Asset| a.browser_download_url.starts_with("https://");
    let setup = assets
        .iter()
        .filter(usable)
        .find(|a| a.name.to_ascii_lowercase().ends_with("setup.exe"));
    if let Some(asset) = setup {
        return Some(asset.browser_download_url.clone());
    }
    let portable = assets
        .iter()
        .filter(usable)
        .find(|a| a.name.to_ascii_lowercase().ends_with(".exe"));
    portable.map(|a| a.browser_download_url.clone())
}

fn page_or_releases(html_url: &str) -> String {
    let trimmed = html_url.trim();
    if trimmed.starts_with("https://github.com/shahittoshariear-spec/Lyra-PoS/") {
        trimmed.to_string()
    } else {
        RELEASES_PAGE.to_string()
    }
}

/// Whether `candidate` is a later version than `current`.
///
/// Versions are dot-separated numbers, optionally prefixed with `v` and
/// optionally carrying a `-prerelease` suffix. A missing component counts as
/// zero, so `2.8` and `2.8.0` are the same release and `2.8.0` beats `2.7.2`.
fn is_newer(candidate: &str, current: &str) -> bool {
    let a = numeric_parts(candidate);
    let b = numeric_parts(current);
    let len = a.len().max(b.len());
    for i in 0..len {
        let left = a.get(i).copied().unwrap_or(0);
        let right = b.get(i).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

fn numeric_parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse().unwrap_or(0)
        })
        .collect()
}

/// Opens an update URL in the person's browser.
///
/// Only this app's own release URLs are allowed through: the command cannot be
/// pointed at an arbitrary address by a compromised screen.
pub fn open_release_page(url: &str) -> Result<(), String> {
    let url = url.trim();
    if !is_allowed_update_url(url) {
        return Err("That is not a Lyra PoS release address.".to_string());
    }
    open_in_browser(url)
}

fn is_allowed_update_url(url: &str) -> bool {
    url.starts_with(RELEASES_PAGE)
        || url.starts_with("https://github.com/shahittoshariear-spec/Lyra-PoS/")
}

#[cfg(windows)]
fn open_in_browser(url: &str) -> Result<(), String> {
    // The shell's own protocol handler. `rundll32` takes the URL as one
    // argument, so unlike `cmd /C start` nothing in it is parsed as a command.
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("The browser could not be opened: {e}"))
}

#[cfg(target_os = "macos")]
fn open_in_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("The browser could not be opened: {e}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("The browser could not be opened: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_compared_by_their_numbers() {
        assert!(is_newer("3.0.0", "2.7.2"));
        assert!(is_newer("v2.8", "2.7.2"));
        assert!(!is_newer("2.8.0", "2.8"));
        assert!(!is_newer("2.7.2", "2.7.2"));
        assert!(!is_newer("2.7", "2.7.2"));
        assert!(!is_newer("v2.6.9", "2.7.2"));
        assert!(is_newer("10.0.0", "9.9.9"));
    }

    #[test]
    fn a_release_url_must_be_one_of_ours() {
        assert!(!is_allowed_update_url("https://example.com/evil.exe"));
        assert!(!is_allowed_update_url(
            "file:///C:/Windows/System32/cmd.exe"
        ));
        assert!(is_allowed_update_url(
            "https://github.com/shahittoshariear-spec/Lyra-PoS/releases"
        ));
        assert!(is_allowed_update_url(
            "https://github.com/shahittoshariear-spec/Lyra-PoS/releases/download/v3.0.0/setup.exe"
        ));
    }

    #[test]
    fn the_setup_installer_is_preferred() {
        let assets = vec![
            Asset {
                name: "Lyra-PoS-9.0.0-release.exe".to_string(),
                browser_download_url: "https://github.com/x/release.exe".to_string(),
            },
            Asset {
                name: "Lyra-PoS-9.0.0-x64-setup.exe".to_string(),
                browser_download_url: "https://github.com/x/setup.exe".to_string(),
            },
        ];
        assert_eq!(
            pick_download(&assets).as_deref(),
            Some("https://github.com/x/setup.exe")
        );
    }

    /// Not part of the normal suite: this one talks to GitHub. Run it with
    /// `cargo test a_live_check -- --ignored` on a machine with a network to
    /// prove the request, the TLS roots and GitHub's JSON still agree.
    #[test]
    #[ignore = "talks to GitHub"]
    fn a_live_check_reads_the_published_release() {
        let info = check("0.0.1").expect("GitHub should answer");
        assert!(!info.version.is_empty());
        assert!(info.available);
        assert!(
            info.page_url
                .starts_with("https://github.com/shahittoshariear-spec/Lyra-PoS/")
        );
        assert!(info.download_url.starts_with("https://github.com/"));
    }
}
