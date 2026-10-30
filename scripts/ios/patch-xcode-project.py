"""Adapt the Xcode project that `tauri ios init` generates for the iPad build.

Run on the CI Mac after `tauri ios init --ci` and before `xcodegen generate`:

    python3 scripts/ios/patch-xcode-project.py src-tauri/gen/apple/project.yml

It links MPVKit (libmpv for src-tauri/src/mpv_ios.rs), adds the native video
surface in src-tauri/ios, makes the app iPad-only and landscape-only, and drops
Tauri's "Build Rust Code" phase because CI builds the Rust library itself
without code signing (see .github/workflows/ios-ipad.yml).
"""

import sys
from pathlib import Path

import yaml

MPVKIT_VERSION = "1.0.0"
LANDSCAPE = ["UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"]


def main(path: Path) -> None:
    project = yaml.safe_load(path.read_text())
    name, target = next((k, v) for k, v in project["targets"].items() if k.endswith("_iOS"))

    project.setdefault("packages", {})["MPVKit"] = {
        "url": "https://github.com/mpvkit/MPVKit.git",
        "exactVersion": MPVKIT_VERSION,
    }
    target.setdefault("dependencies", []).append({"package": "MPVKit", "product": "MPVKit"})
    # project.yml lives in src-tauri/gen/apple; the Swift sources in src-tauri/ios.
    target.setdefault("sources", []).append({"path": "../../ios"})

    target["preBuildScripts"] = [
        step for step in target.get("preBuildScripts", []) if step.get("name") != "Build Rust Code"
    ]

    info = target.setdefault("info", {}).setdefault("properties", {})
    info["UISupportedInterfaceOrientations"] = LANDSCAPE
    info["UISupportedInterfaceOrientations~ipad"] = LANDSCAPE
    # iPadOS ignores the orientation list for apps that support multitasking.
    info["UIRequiresFullScreen"] = True
    info["UIStatusBarHidden"] = True
    info["UIViewControllerBasedStatusBarAppearance"] = False
    # Debrid links, addons and the local torrent stream server are often plain HTTP.
    info["NSAppTransportSecurity"] = {"NSAllowsArbitraryLoads": True}
    info["NSLocalNetworkUsageDescription"] = (
        "Harbor uses your local network for torrent streaming and casting."
    )
    info["UIFileSharingEnabled"] = True
    info["LSSupportsOpeningDocumentsInPlace"] = True
    info["UIBackgroundModes"] = ["audio"]

    settings = target.setdefault("settings", {}).setdefault("base", {})
    settings["TARGETED_DEVICE_FAMILY"] = "2"

    path.write_text(yaml.safe_dump(project, sort_keys=False))
    print(f"patched {name} in {path}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
