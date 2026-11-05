"""iCloud Desk launcher.

    python main.py            # desktop window (pywebview / Edge WebView2)
    python main.py --browser  # serve and open in the default browser
    python main.py --server   # serve only (e.g. for development)
    python main.py --demo     # fake data, no Apple account needed
"""

from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
import threading
import time
import webbrowser


def _free_port(preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def _wait_ready(port: int, timeout: float = 15) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)


def main() -> None:
    parser = argparse.ArgumentParser(description="iCloud Desk")
    parser.add_argument("--browser", action="store_true", help="open in the default browser instead of a window")
    parser.add_argument("--server", action="store_true", help="run the HTTP server only")
    parser.add_argument("--demo", action="store_true", help="use fake demo data")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ICLOUD_DESK_PORT", 8848)))
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    if args.demo:
        os.environ["ICLOUD_DESK_DEMO"] = "1"

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    import uvicorn

    from app.server import app

    port = _free_port(args.port) if not args.server else args.port
    url = f"http://127.0.0.1:{port}/"
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="debug" if args.debug else "warning")
    server = uvicorn.Server(config)

    if args.server:
        print(f"iCloud Desk API: {url}")
        server.run()
        return

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    _wait_ready(port)

    if args.browser:
        print(f"iCloud Desk: {url}  (Ctrl+C 退出)")
        webbrowser.open(url)
        try:
            while thread.is_alive():
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        return

    try:
        import webview
    except ImportError:
        print("pywebview 未安装，改用浏览器打开", file=sys.stderr)
        webbrowser.open(url)
        thread.join()
        return

    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    webview.create_window("iCloud Desk", url, width=1280, height=820, min_size=(900, 600))
    webview.start(private_mode=False, storage_path=os.path.join(os.environ.get("APPDATA", "."), "icloud-desk", "webview"), debug=args.debug)
    server.should_exit = True


if __name__ == "__main__":
    main()
