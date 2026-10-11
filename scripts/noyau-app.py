#!/usr/bin/env python3
"""
Noyau Desktop App
Application native ultra-légère pour Noyau basée sur WebKitGTK.
Consomme ~60 Mo de RAM et 0% CPU au repos (vs >1 Go pour Firefox).
"""

import sys
import os
import json
import signal
import shutil

# Assurer l'arrêt propre sur Ctrl+C
signal.signal(signal.SIGINT, signal.SIG_DFL)

import gi
gi.require_version('Gtk', '3.0')
try:
    gi.require_version('WebKit2', '4.1')
except ValueError:
    gi.require_version('WebKit2', '4.0')
from gi.repository import Gtk, Gdk, WebKit2, GLib, Gio

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.expanduser("~/.local/share/noyau-app")
STATE_FILE = os.path.join(DATA_DIR, "window-state.json")
ICON_PATH = os.path.join(ROOT_DIR, "public", "icon-512.png")
DEFAULT_URL = os.environ.get("NOYAU_URL", "https://127.0.0.1:4242")


def install_desktop_entry():
    """Installe le lanceur d'application Ubuntu / GNOME et la commande ~/.local/bin/noyau-app"""
    os.makedirs(DATA_DIR, exist_ok=True)
    
    # 1. Copier l'icône dans le dossier d'icônes standard
    icon_dir = os.path.expanduser("~/.local/share/icons/hicolor/512x512/apps")
    os.makedirs(icon_dir, exist_ok=True)
    target_icon = os.path.join(icon_dir, "noyau.png")
    if os.path.exists(ICON_PATH):
        try:
            shutil.copyfile(ICON_PATH, target_icon)
        except Exception as e:
            print(f"Erreur copie icône: {e}")

    # 2. Créer le script de lancement dans ~/.local/bin
    bin_dir = os.path.expanduser("~/.local/bin")
    os.makedirs(bin_dir, exist_ok=True)
    bin_script = os.path.join(bin_dir, "noyau-app")
    app_py = os.path.abspath(__file__)
    
    script_content = f"""#!/bin/sh
exec python3 "{app_py}" "$@"
"""
    with open(bin_script, "w") as f:
        f.write(script_content)
    os.chmod(bin_script, 0o755)

    # 3. Créer le fichier .desktop
    apps_dir = os.path.expanduser("~/.local/share/applications")
    os.makedirs(apps_dir, exist_ok=True)
    desktop_file = os.path.join(apps_dir, "noyau.desktop")
    desktop_content = f"""[Desktop Entry]
Name=Noyau
GenericName=Centre de contrôle IA
Comment=Interface autonome ultra-légère pour Noyau
Exec={bin_script}
Icon=noyau
Terminal=false
Type=Application
Categories=Development;Utility;
StartupWMClass=noyau-app
Keywords=ia;agent;codex;claude;noyau;dashboard;
"""
    with open(desktop_file, "w") as f:
        f.write(desktop_content)
    os.chmod(desktop_file, 0o755)

    # 4. Créer le raccourci sur le Bureau de l'utilisateur si le dossier existe
    desktop_dirs = [os.path.expanduser("~/desktop"), os.path.expanduser("~/Desktop"), os.path.expanduser("~/Bureau")]
    for d in desktop_dirs:
        if os.path.isdir(d):
            desk_shortcut = os.path.join(d, "Noyau.desktop")
            try:
                with open(desk_shortcut, "w") as f:
                    f.write(desktop_content.replace("Icon=noyau", f"Icon={ICON_PATH}"))
                os.chmod(desk_shortcut, 0o755)
                os.system(f"gio set '{desk_shortcut}' metadata::trusted true >/dev/null 2>&1")
            except Exception as e:
                print(f"Erreur création raccourci Bureau: {e}")

    print(f"Application Noyau installée dans {desktop_file} et {bin_script}")


class NoyauApp(Gtk.Window):
    def __init__(self, target_url=DEFAULT_URL):
        super().__init__(title="Noyau")
        self.set_role("noyau-app")
        self.set_wmclass("noyau-app", "Noyau")
        self.target_url = target_url
        self.reconnecting = False
        self.retry_timer = None

        os.makedirs(DATA_DIR, exist_ok=True)

        # Icône de fenêtre
        if os.path.exists(ICON_PATH):
            try:
                self.set_icon_from_file(ICON_PATH)
            except Exception:
                pass

        # Charger la géométrie précédente
        self.load_geometry()

        # Configuration WebKit
        context = WebKit2.WebContext.get_default()
        
        # Persistance des cookies
        cookie_mgr = context.get_cookie_manager()
        cookie_mgr.set_persistent_storage(
            os.path.join(DATA_DIR, "cookies.txt"),
            WebKit2.CookiePersistentStorage.TEXT
        )

        # Désactiver les erreurs TLS sur localhost / 127.0.0.1
        try:
            context.set_tls_errors_policy(WebKit2.TLSErrorsPolicy.IGNORE)
        except Exception:
            pass

        # Gestionnaire de cache et données de site
        data_mgr = context.get_website_data_manager()
        try:
            data_mgr.set_base_data_directory(os.path.join(DATA_DIR, "data"))
        except Exception:
            pass

        self.webview = WebKit2.WebView.new_with_context(context)
        
        settings = self.webview.get_settings()
        settings.set_enable_javascript(True)
        settings.set_enable_webgl(True)
        settings.set_enable_developer_extras(True)
        settings.set_enable_html5_local_storage(True)
        settings.set_enable_html5_database(True)
        settings.set_enable_page_cache(True)
        settings.set_enable_smooth_scrolling(True)
        settings.set_user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) NoyauApp/1.0 Chrome/120.0.0.0 Safari/537.36")

        # Accepter certificat auto-signé sur échec TLS
        self.webview.connect("load-failed-with-tls-errors", self.on_tls_error)
        self.webview.connect("load-failed", self.on_load_failed)
        self.webview.connect("load-changed", self.on_load_changed)

        # Raccourcis clavier (F5, Ctrl+R, F11, etc.)
        self.connect("key-press-event", self.on_key_press)
        self.connect("delete-event", self.on_delete_event)

        # Structure GTK
        self.add(self.webview)
        self.webview.load_uri(self.target_url)

    def load_geometry(self):
        default_w, default_h = 1320, 860
        self.set_default_size(default_w, default_h)
        self.set_position(Gtk.WindowPosition.CENTER)

        if os.path.exists(STATE_FILE):
            try:
                with open(STATE_FILE, "r") as f:
                    state = json.load(f)
                w = state.get("width", default_w)
                h = state.get("height", default_h)
                self.resize(max(800, w), max(600, h))
                if "x" in state and "y" in state:
                    self.move(state["x"], state["y"])
                else:
                    self.set_position(Gtk.WindowPosition.CENTER)
                if state.get("maximized"):
                    self.maximize()
                return
            except Exception:
                pass

        self.set_position(Gtk.WindowPosition.CENTER)

    def save_geometry(self):
        try:
            w, h = self.get_size()
            x, y = self.get_position()
            maximized = self.is_maximized()
            with open(STATE_FILE, "w") as f:
                json.dump({"width": w, "height": h, "x": x, "y": y, "maximized": maximized}, f)
        except Exception:
            pass

    def on_delete_event(self, widget, event):
        self.save_geometry()
        Gtk.main_quit()
        return False

    def on_tls_error(self, webview, failing_uri, certificate, errors):
        # Autoriser automatiquement le certificat local pour 127.0.0.1 et localhost
        try:
            host = "127.0.0.1" if "127.0.0.1" in failing_uri else "localhost"
            webview.allow_tls_certificate_for_host(certificate, host)
            webview.load_uri(failing_uri)
            return True
        except Exception as e:
            print(f"TLS allow error: {e}")
            return False

    def on_load_failed(self, webview, load_event, failing_uri, error):
        # En cas de perte de connexion (serveur Noyau en redémarrage)
        if not self.reconnecting:
            self.reconnecting = True
            error_html = """
            <!DOCTYPE html>
            <html lang="fr">
            <head>
              <meta charset="utf-8">
              <style>
                body {
                  margin: 0;
                  height: 100vh;
                  display: flex;
                  flex-direction: column;
                  align-items: center;
                  justify-content: center;
                  background: #080b0a;
                  color: #8d9791;
                  font-family: ui-monospace, monospace;
                  text-align: center;
                }
                .spinner {
                  width: 36px;
                  height: 36px;
                  border: 3px solid #232d27;
                  border-top-color: #b8ff5e;
                  border-radius: 50%;
                  animation: spin .8s linear infinite;
                  margin-bottom: 20px;
                }
                @keyframes spin { to { transform: rotate(360deg); } }
                h2 { color: #dbe4de; font-size: 16px; margin: 0 0 8px; }
                p { font-size: 11px; margin: 0 0 20px; color: #68736c; }
                button {
                  background: #141a16;
                  border: 1px solid #334036;
                  border-radius: 6px;
                  color: #b8ff5e;
                  padding: 8px 16px;
                  font-size: 11px;
                  cursor: pointer;
                }
                button:hover { background: #1b241e; border-color: #55703f; }
              </style>
            </head>
            <body>
              <div class="spinner"></div>
              <h2>Noyau indisponible</h2>
              <p>Reconnexion automatique en cours…</p>
              <button onclick="location.reload()">Réessayer immédiatement</button>
            </body>
            </html>
            """
            webview.load_html(error_html, failing_uri)
            self.schedule_retry()
        return True

    def on_load_changed(self, webview, load_event):
        if load_event == WebKit2.LoadEvent.FINISHED:
            uri = webview.get_uri() or ""
            if "127.0.0.1" in uri or "localhost" in uri:
                self.reconnecting = False
                if self.retry_timer:
                    GLib.source_remove(self.retry_timer)
                    self.retry_timer = None

    def schedule_retry(self):
        if self.retry_timer:
            GLib.source_remove(self.retry_timer)
        self.retry_timer = GLib.timeout_add_seconds(2, self.do_retry)

    def do_retry(self):
        if self.reconnecting:
            self.webview.load_uri(self.target_url)
            return True  # Répéter toutes les 2s jusqu'au succès
        return False

    def on_key_press(self, widget, event):
        keyval = event.keyval
        state = event.state

        # F5 ou Ctrl+R : recharger la page
        if keyval == Gdk.KEY_F5:
            if state & Gdk.ModifierType.CONTROL_MASK or state & Gdk.ModifierType.SHIFT_MASK:
                self.webview.reload_bypass_cache()
            else:
                self.webview.reload()
            return True

        if (state & Gdk.ModifierType.CONTROL_MASK) and keyval in (Gdk.KEY_r, Gdk.KEY_R):
            if state & Gdk.ModifierType.SHIFT_MASK:
                self.webview.reload_bypass_cache()
            else:
                self.webview.reload()
            return True

        # F11 : Plein écran
        if keyval == Gdk.KEY_F11:
            if self.get_window().get_state() & Gdk.WindowState.FULLSCREEN:
                self.unfullscreen()
            else:
                self.fullscreen()
            return True

        # Ctrl+Q : Quitter
        if (state & Gdk.ModifierType.CONTROL_MASK) and keyval in (Gdk.KEY_q, Gdk.KEY_Q):
            self.save_geometry()
            Gtk.main_quit()
            return True

        return False


def main():
    if "--install-desktop" in sys.argv:
        install_desktop_entry()
        return

    # Installer automatiquement le .desktop si pas encore présent
    desktop_file = os.path.expanduser("~/.local/share/applications/noyau.desktop")
    if not os.path.exists(desktop_file):
        install_desktop_entry()

    url = DEFAULT_URL
    for arg in sys.argv[1:]:
        if arg.startswith("http"):
            url = arg

    app = NoyauApp(target_url=url)
    app.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
