#!/usr/bin/python3
"""Launch Dimension's local renderer in a GTK window."""

import argparse
import fcntl
import functools
import json
import mimetypes
import secrets
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2

APP_ID = "io.github.caraveo.Dimension"
UI_ROOT = Path(__file__).resolve().parent / "ui"
PREFERENCE_KEYS = {"wire", "light", "post", "spin", "clean", "introSeen"}
FORMATS = "glb gltf 3ds 3mf amf dae fbx obj pcd ply stl usd usda usdc usdz vox vtk vtp".split()


def read_preferences(path):
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(stored, dict):
        return {}
    return {key: value for key, value in stored.items() if key in PREFERENCE_KEYS and isinstance(value, bool)}


def save_preference(path, key, value):
    # Multiple model windows can update different preferences at the same time.
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        preferences = read_preferences(path)
        preferences[key] = value
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as temporary:
            draft = Path(temporary.name)
            try:
                json.dump(preferences, temporary)
                temporary.flush()
                draft.replace(path)
            finally:
                draft.unlink(missing_ok=True)


class AssetServer(ThreadingHTTPServer):
    """Serve the interface and assets relative to a model the user opened."""

    def __init__(self):
        super().__init__(("127.0.0.1", 0), AssetRequest)
        self.token = secrets.token_urlsafe(24)
        self.origin = f"http://127.0.0.1:{self.server_port}"
        self.base = f"{self.origin}/{self.token}/"
        self.models = {}

    def add_model(self, path):
        key = secrets.token_urlsafe(16)
        self.models[key] = path.parent
        return f"{self.base}model/{key}/{quote(path.name, safe='')}"


class AssetRequest(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        prefix = f"/{self.server.token}/"
        route = unquote(urlsplit(self.path).path)
        if not route.startswith(prefix):
            self.send_error(404)
            return
        relative = route[len(prefix):]
        root = UI_ROOT
        model_asset = relative.startswith("model/")
        if model_asset:
            _, _, location = relative.partition("/")
            key, _, relative = location.partition("/")
            root = self.server.models.get(key)
            if root is None:
                self.send_error(404)
                return
        try:
            file = (root / relative).resolve()
            if not file.is_relative_to(root) or not file.is_file():
                self.send_error(404)
                return
            handle = file.open("rb")
        except (OSError, ValueError, RuntimeError):
            self.send_error(404)
            return
        with handle:
            mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            if model_asset and not mime.startswith("image/"):
                mime = "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(file.stat().st_size))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                shutil.copyfileobj(handle, self.wfile)
            except (BrokenPipeError, ConnectionResetError):
                pass


class Dimension:
    def __init__(self, server, initial_path):
        self.server = server
        self.ready = False
        self.pending = initial_path
        self.preferences = Path(GLib.get_user_config_dir()) / "dimension" / "preferences.json"
        self.window = Gtk.Window(title="Dimension")
        self.window.set_icon_from_file(str(UI_ROOT / "icons" / "dimension.png"))
        self.window.set_default_size(1120, 750)
        self.window.set_size_request(390, 350)
        self.window.connect("destroy", lambda *_: Gtk.main_quit())
        self.window.connect("key-press-event", self.on_key)

        self.manager = WebKit2.UserContentManager()
        settings = json.dumps(read_preferences(self.preferences))
        self.manager.add_script(WebKit2.UserScript.new(
            f"window.dimensionPreferences = {settings};",
            WebKit2.UserContentInjectedFrames.TOP_FRAME,
            WebKit2.UserScriptInjectionTime.START,
            None,
            None,
        ))
        self.manager.register_script_message_handler("preferences")
        self.manager.connect("script-message-received::preferences", self.on_preference)
        self.manager.register_script_message_handler("dimension")
        self.manager.connect("script-message-received::dimension", self.on_message)
        self.web = WebKit2.WebView.new_with_user_content_manager(self.manager)
        self.web.set_background_color(Gdk.RGBA(0.063, 0.063, 0.09, 1))
        self.web.connect("context-menu", lambda *_: True)
        self.web.connect("decide-policy", self.on_navigation)
        self.window.add(self.web)

        self.web.drag_dest_set(Gtk.DestDefaults.ALL, [], Gdk.DragAction.COPY)
        self.web.drag_dest_add_uri_targets()
        self.web.connect("drag-data-received", self.on_drop)

        self.window.show_all()
        self.web.load_uri(f"{server.base}index.html")

    def on_navigation(self, _web, decision, kind):
        if kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
            decision.ignore()
            return True
        if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            if uri != f"{self.server.base}index.html":
                decision.ignore()
                return True
        return False

    def on_message(self, _manager, message):
        action = message.get_js_value().to_string()
        if action == "open":
            self.choose_model()
        elif action == "ready":
            self.ready = True
            if self.pending is not None:
                self.open_model(self.pending)
                self.pending = None

    def on_preference(self, _manager, message):
        try:
            payload = json.loads(message.get_js_value().to_string())
            if not isinstance(payload, dict):
                return
            key, value = payload.get("key"), payload.get("value")
            if isinstance(key, str) and key in PREFERENCE_KEYS and isinstance(value, bool):
                save_preference(self.preferences, key, value)
        except (ValueError, OSError) as error:
            print(f"Dimension preferences: {error}", file=sys.stderr)

    def on_key(self, _window, event):
        if event.state & Gdk.ModifierType.CONTROL_MASK and event.keyval in (Gdk.KEY_o, Gdk.KEY_O):
            self.choose_model()
            return True
        return False

    def on_drop(self, _web, context, _x, _y, data, _info, time):
        paths = [Gio.File.new_for_uri(uri).get_path() for uri in data.get_uris()]
        local = next((Path(path) for path in paths if path), None)
        if local:
            self.open_model(local)
        Gtk.drag_finish(context, local is not None, False, time)

    def choose_model(self):
        dialog = Gtk.FileChooserDialog(
            title="Open a 3D model", transient_for=self.window,
            action=Gtk.FileChooserAction.OPEN,
        )
        dialog.add_buttons("_Cancel", Gtk.ResponseType.CANCEL, "_Open", Gtk.ResponseType.ACCEPT)
        supported = Gtk.FileFilter()
        supported.set_name("3D models")
        for extension in FORMATS:
            supported.add_pattern(f"*.{extension}")
            supported.add_pattern(f"*.{extension.upper()}")
        dialog.add_filter(supported)
        all_files = Gtk.FileFilter()
        all_files.set_name("All files")
        all_files.add_pattern("*")
        dialog.add_filter(all_files)
        response = dialog.run()
        filename = dialog.get_filename()
        dialog.destroy()
        if response == Gtk.ResponseType.ACCEPT and filename:
            self.open_model(Path(filename))

    def open_model(self, filename):
        if not self.ready:
            self.pending = filename
            return
        original_name = filename.name
        path = filename.resolve()
        if not path.is_file():
            self.show_error(f"Could not read {original_name}.")
            return
        payload = {
            "url": self.server.add_model(path),
            "name": original_name,
            "format": filename.suffix.lstrip(".").lower(),
        }
        script = f"window.dimensionLoad?.({json.dumps(payload)})"
        self.web.evaluate_javascript(script, -1, None, None, None, None, None)

    def show_error(self, text):
        dialog = Gtk.MessageDialog(
            transient_for=self.window, modal=True, message_type=Gtk.MessageType.ERROR,
            buttons=Gtk.ButtonsType.CLOSE, text=text,
        )
        dialog.run()
        dialog.destroy()


def main():
    parser = argparse.ArgumentParser(description="Dimension 3D model viewer")
    parser.add_argument("model", nargs="?", type=Path, help="model to open")
    args = parser.parse_args()
    GLib.set_prgname(APP_ID)
    Gdk.set_program_class(APP_ID)
    with AssetServer() as server:
        serve = functools.partial(server.serve_forever, poll_interval=0.1)
        threading.Thread(target=serve, daemon=True).start()
        viewer = Dimension(server, args.model)
        Gtk.main()
        server.shutdown()
        viewer.web.stop_loading()


if __name__ == "__main__":
    main()
