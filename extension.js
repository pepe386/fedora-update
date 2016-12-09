/*
    This file is part of Fedora Linux Updates Indicator

    Fedora Linux Updates Indicator is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Fedora Linux Updates Indicator is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with fedora Fedora Updates Indicator.  If not, see <http://www.gnu.org/licenses/>.

    Copyright 2016 Raphaël Rochet
    Copyright 2016 Julio Galvan
*/

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;

const St = imports.gi.St;
const GObject = imports.gi.GObject;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;

const Main = imports.ui.main;
const Panel = imports.ui.panel;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;

const Util = imports.misc.util;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;

const Format = imports.format;
const Gettext = imports.gettext.domain('fedora-update');
const _ = Gettext.gettext;

/* Options */
let ALWAYS_VISIBLE     = true;
let SHOW_COUNT         = true;
let CHECK_INTERVAL     = 60*60;   // 1h
let NOTIFY             = false;
let HOWMUCH            = 0;
let TRANSIENT          = true;
let AUTO_EXPAND_LIST   = 0;
let ALLOW_NO_PASS	   = false;
let PREPEND_CMD        = "/usr/bin/pkexec --user root ";
let STOCK_CHECK_CMD    = "dnf check-update";
let STOCK_UPDATE_CMD   = "dnf update -y";
let STOCK_LIST_CMD	   = "/usr/bin/dnf list updates";
let CHECK_CMD          = PREPEND_CMD + STOCK_CHECK_CMD;
let UPDATE_CMD         = PREPEND_CMD + STOCK_UPDATE_CMD;
let LIST_CMD		   = STOCK_LIST_CMD;

/* Variables we want to keep when extension is disabled (eg during screen lock) */
let UPDATES_PENDING    = -1;
let UPDATES_LIST       = [];


function init() {
	String.prototype.format = Format.format;
	Utils.initTranslations("fedora-update");
}

const FedoraUpdateIndicator = new Lang.Class({
	Name: 'FedoraUpdateIndicator',
	Extends: PanelMenu.Button,

	_TimeoutId: null,
	_FirstTimeoutId: null,
	_updateProcess_sourceId: null,
	_updateProcess_stream: null,
	_updateProcess_pid: null,
	_updateList: [],

	_init: function() {
		this.parent(0.0, "FedoraUpdateIndicator");
		Gtk.IconTheme.get_default().append_search_path(Me.dir.get_child('icons').get_path());

		this.updateIcon = new St.Icon({icon_name: "arch-unknown-symbolic", style_class: 'system-status-icon'});

		let box = new St.BoxLayout({ vertical: false, style_class: 'panel-status-menu-box' });
		this.label = new St.Label({ text: '',
			y_expand: true,
			y_align: Clutter.ActorAlign.CENTER });

		box.add_child(this.updateIcon);
		box.add_child(this.label);
		this.actor.add_child(box);

		// Prepare the special menu : a submenu for updates list that will look like a regular menu item when disabled
		// Scrollability will also be taken care of by the popupmenu
		this.menuExpander = new PopupMenu.PopupSubMenuMenuItem('');
		this.updatesListMenuLabel = new St.Label();
		this.menuExpander.menu.box.add(this.updatesListMenuLabel);
		this.menuExpander.menu.box.style_class = 'fedora-updates-list';

		// Other standard menu items
		let settingsMenuItem = new PopupMenu.PopupMenuItem(_('Settings'));
		this.updateNowMenuItem = new PopupMenu.PopupMenuItem(_('Update now'));

		// A special "Checking" menu item with a stop button
		this.checkingMenuItem = new PopupMenu.PopupBaseMenuItem( {reactive:false} );
		let checkingLabel = new St.Label({ text: _('Checking') + " …" });
		let cancelButton = new St.Button({
			child: new St.Icon({ icon_name: 'process-stop-symbolic' }),
			style_class: 'system-menu-action fedora-updates-menubutton',
			x_expand: true
		});
		cancelButton.set_x_align(Clutter.ActorAlign.END);
		this.checkingMenuItem.actor.add_actor( checkingLabel );
		this.checkingMenuItem.actor.add_actor( cancelButton  );

		// A little trick on "check now" menuitem to keep menu opened
		this.checkNowMenuItem = new PopupMenu.PopupMenuItem( _('Check now') );
		this.checkNowMenuContainer = new PopupMenu.PopupMenuSection();
		this.checkNowMenuContainer.actor.add_actor(this.checkNowMenuItem.actor);

		// Assemble all menu items into the popup menu
		this.menu.addMenuItem(this.menuExpander);
		this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
		this.menu.addMenuItem(this.updateNowMenuItem);
		this.menu.addMenuItem(this.checkingMenuItem);
		this.menu.addMenuItem(this.checkNowMenuContainer);
		this.menu.addMenuItem(settingsMenuItem);

		// Bind some events
		this.menu.connect('open-state-changed', Lang.bind(this, this._onMenuOpened));
		this.checkNowMenuItem.connect('activate', Lang.bind(this, this._checkUpdates));
		cancelButton.connect('clicked', Lang.bind(this, this._cancelCheck));
		settingsMenuItem.connect('activate', Lang.bind(this, this._openSettings));
		this.updateNowMenuItem.connect('activate', Lang.bind(this, this._updateNow));

		// Load settings
		this._settings = Utils.getSettings();
		this._settingsChangedId = this._settings.connect('changed', Lang.bind(this, this._applySettings));
		this._applySettings();
		this._showChecking(false);


		// Restore previous state
		this._updateList = UPDATES_LIST;
		this._updateStatus(UPDATES_PENDING);
		this._startFolderMonitor();

	},

	_openSettings: function () {
		Util.spawn([ "gnome-shell-extension-prefs", Me.uuid ]);
	},



	_applySettings: function() {
		ALWAYS_VISIBLE = this._settings.get_boolean('always-visible');
		SHOW_COUNT = this._settings.get_boolean('show-count');
		CHECK_INTERVAL = 60 * this._settings.get_int('check-interval');
		NOTIFY = this._settings.get_boolean('notify');
		HOWMUCH = this._settings.get_int('howmuch');
		TRANSIENT = this._settings.get_boolean('transient');
		AUTO_EXPAND_LIST = this._settings.get_int('auto-expand-list');
		ALLOW_NO_PASS = this._settings.get_boolean("allow-no-passwd");

        if (this._settings.get_string('update-cmd') !== "")
            UPDATE_CMD = PREPEND_CMD + this._settings.get_string('update-cmd');
        else
            UPDATE_CMD = PREPEND_CMD + STOCK_UPDATE_CMD;

		if(ALLOW_NO_PASS)
            LIST_CMD = PREPEND_CMD + STOCK_LIST_CMD;
        else
        	LIST_CMD = STOCK_LIST_CMD;

		this._checkShowHide();
		let that = this;
		if (this._TimeoutId)
			GLib.source_remove(this._TimeoutId);
		this._TimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_INTERVAL, function () {
			that._checkUpdates();
			return true;
		});
	},

	destroy: function() {
		if (this._updateProcess_sourceId) {
			// We leave the checkupdate process end by itself but undef handles to avoid zombies
			GLib.source_remove(this._updateProcess_sourceId);
			this._updateProcess_sourceId = null;
			this._updateProcess_stream = null;
		}
		if (this._FirstTimeoutId) {
			GLib.source_remove(this._FirstTimeoutId);
			this._FirstTimeoutId = null;
		}
		if (this._TimeoutId) {
			GLib.source_remove(this._TimeoutId);
			this._TimeoutId = null;
		}
		this.parent();
	},


	_checkShowHide: function() {
		if ( UPDATES_PENDING == -3 ) {
			// Do not apply visibility change while checking for updates
			return;
		}
		if (!ALWAYS_VISIBLE && UPDATES_PENDING < 1) {
			this.actor.visible = false;
		} else {
			this.actor.visible = true;
		}
		this.label.visible = SHOW_COUNT;
	},

	_onMenuOpened: function() {
		// This event is fired when menu is shown or hidden
		// Only open the submenu if the menu is being opened and there is something to show
		this._checkAutoExpandList();
	},

	_checkAutoExpandList: function() {
		if (this.menu.isOpen && UPDATES_PENDING > 0 && UPDATES_PENDING <= AUTO_EXPAND_LIST) {
			this.menuExpander.setSubmenuShown(true);
		} else {
			this.menuExpander.setSubmenuShown(false);
		}
	},

	_showChecking: function(isChecking) {
		if (isChecking == true) {
			this.updateIcon.set_icon_name('arch-unknown-symbolic');
			this.checkNowMenuContainer.actor.visible = false;
			this.checkingMenuItem.actor.visible = true;;
		} else {
			this.checkNowMenuContainer.actor.visible = true;;
			this.checkingMenuItem.actor.visible = false;;
		}
	},

	_updateStatus: function(updatesCount) {
		updatesCount = typeof updatesCount === 'number' ? updatesCount : UPDATES_PENDING;
		if (updatesCount > 0) {
			// Updates pending
			this.updateIcon.set_icon_name('arch-updates-symbolic');
			this._updateMenuExpander( true, Gettext.ngettext( "%d update pending", "%d updates pending", updatesCount ).format(updatesCount) );
			this.updatesListMenuLabel.set_text( this._updateList.join("\n") );
			this.label.set_text(updatesCount.toString());
			if (NOTIFY && UPDATES_PENDING < updatesCount) {
				if (HOWMUCH > 0) {
					let updateList = [];
					if (HOWMUCH > 1) {
						updateList = this._updateList;
					} else {
						// Keep only packets that was not in the previous notification
						updateList = this._updateList.filter(function(pkg) { return UPDATES_LIST.indexOf(pkg) < 0 });
					}
					if (updateList.length > 0) {
						// Show notification only if there's new updates
						this._showNotification(
							Gettext.ngettext( "New Update", "New Updates", updateList.length ),
							updateList.join(', '),
							false
						);
					}
				} else {
					this._showNotification(
						Gettext.ngettext( "New Update", "New Updates", updatesCount ),
						Gettext.ngettext( "There is %d update pending", "There are %d updates pending", updatesCount ).format(updatesCount),
						false
					);
				}
			}
			// Store the new list
			UPDATES_LIST = this._updateList;
		} else {
			this.updatesListMenuLabel.set_text("");
			this.label.set_text('');
			if (updatesCount == -1) {
				// Unknown
				this.updateIcon.set_icon_name('arch-unknown-symbolic');
				this._updateMenuExpander( false, '' );
			} else if (updatesCount == -2) {
				// Error
				this.updateIcon.set_icon_name('arch-error-symbolic');
				this._updateMenuExpander( false, _('Error') );
			} else {
				// Up to date
				this.updateIcon.set_icon_name('arch-uptodate-symbolic');
				this._updateMenuExpander( false, _('Up to date :)') );
				UPDATES_LIST = []; // Reset stored list
			}
		}
		UPDATES_PENDING = updatesCount;
		this._checkAutoExpandList();
		this._checkShowHide();
	},

	_updateMenuExpander: function(enabled, label) {
		if (label == "") {
			// No text, hide the menuitem
			this.menuExpander.actor.visible = false;
		} else {
		// We make our expander look like a regular menu label if disabled
			this.menuExpander.actor.reactive = enabled;
			this.menuExpander._triangle.visible = enabled;
			this.menuExpander.label.set_text(label);
			this.menuExpander.actor.visible = true;
		}

		// 'Update now' visibility is linked so let's save a few lines and set it here
		this.updateNowMenuItem.actor.reactive = enabled;
	},


    _updateNow: function () {
        this.menu.close();
        if(this._updateProcess_sourceId) {
            // A check is running ! Maybe we should kill it and run another one ?
            return;
        }
        try {
            // Parse check command line
            let [parseok, argvp] = GLib.shell_parse_argv( UPDATE_CMD );
            if (!parseok) { throw 'Parse error' };
            let [res, pid, in_fd, out_fd, err_fd]  = GLib.spawn_async_with_pipes(null, argvp, null, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);

            // We will process the output at once when it's done
            this._updateProcess_sourceId = GLib.child_watch_add(0, pid, Lang.bind(this, this._updateNowEnd));
            this._updateProcess_pid = pid;
        } catch (err) {
            // TODO log err.message.toString() ?
        }
    },

    _updateNowEnd: function() {
        // Free resources
        if (this._updateProcess_sourceId)
            GLib.source_remove(this._updateProcess_sourceId);
        this._updateProcess_sourceId = null;
        this._updateProcess_pid = null;

        this._showNotification("Update Complete", "All packages were updated", true);

        // Update indicator
        this._readUpdates();
    },

    _readUpdates: function() {
        // Run asynchronously, to avoid  shell freeze - even for a 1s check
        try {
            // Parse check command line
			let [parseok, argvp] = GLib.shell_parse_argv( LIST_CMD );
            if (!parseok) { throw 'Parse error' };
            let [res, pid, in_fd, out_fd, err_fd]  = GLib.spawn_async_with_pipes(null, argvp, null, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
            // Let's buffer the command's output - that's a input for us !
            this._updateProcess_stream = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({fd: out_fd})
            });
            // We will process the output at once when it's done
            this._updateProcess_sourceId = GLib.child_watch_add(0, pid, Lang.bind(this, this._listUpgrades));
            this._updateProcess_pid = pid;
        } catch (err) {
            this._showChecking(false);
            // TODO log err.message.toString() ?
            this._updateStatus(-2);
        }
    },

    _listUpgrades: function() {
        // Read the buffered output
        let updateList = [];
        let out, size;

        //!!!!!!!!!!!!!! REMOVE FIRST TWO LINES !!!!!!
        let skip_first_line = true;
        let skip_second_line = true;

        do {
            [out, size] = this._updateProcess_stream.read_line_utf8(null);
            if (skip_first_line) {
                skip_first_line = false;
                continue;
            }
            if (skip_second_line) {
                skip_second_line = false;
                continue;
            }
            if (out) updateList.push(out);
        } while (out);
        updateList = updateList.map(function(p) {
            // Try to keep only what's before the first space
            var chunks = p.split(" ", 1);
            return chunks[0];
        });
        this._updateList = updateList;
        this._listUpgradesEnd();
    },

    _listUpgradesEnd: function() {
        // Free resources
        this._updateProcess_stream.close(null);
        this._updateProcess_stream = null;
        if (this._updateProcess_sourceId)
            GLib.source_remove(this._updateProcess_sourceId);
        this._updateProcess_sourceId = null;
        this._updateProcess_pid = null;
        // Update indicator
        this._showChecking(false);
        this._updateStatus(this._updateList.length);
    },

    _checkUpdates: function() {
        this.menu.close();
        if(this._updateProcess_sourceId) {
            // A check is already running ! Maybe we should kill it and run another one ?
            return;
        }
        // Run asynchronously, to avoid  shell freeze - even for a 1s check
        this._showChecking(true);
        try {
            // Parse check command line
            let [parseok, argvp] = GLib.shell_parse_argv( CHECK_CMD );
            if (!parseok) { throw 'Parse error' };
            let [res, pid, in_fd, out_fd, err_fd]  = GLib.spawn_async_with_pipes(null, argvp, null, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);

            // We will process the output at once when it's done
            this._updateProcess_sourceId = GLib.child_watch_add(0, pid, Lang.bind(this, this._checkUpdatesEnd));
            this._updateProcess_pid = pid;
        } catch (err) {
            this._showChecking(false);
            // TODO log err.message.toString() ?
            this._updateStatus(-2);
        }
    },

    _cancelCheck: function() {
        if (this._updateProcess_pid == null) { return; };
        Util.spawnCommandLine( "kill " + this._updateProcess_pid );
        this._updateProcess_pid = null; // Prevent double kill
        this._checkUpdatesEnd();
    },

    _checkUpdatesEnd: function() {
        // Free resources
        if (this._updateProcess_sourceId)
            GLib.source_remove(this._updateProcess_sourceId);
        this._updateProcess_sourceId = null;
        this._updateProcess_pid = null;
        // Update indicator
        this._readUpdates()
    },


	_showNotification: function(title, message, removeAction) {
		if (this._notifSource == null) {
			// We have to prepare this only once
			this._notifSource = new MessageTray.SystemNotificationSource();
			this._notifSource.createIcon = function() {
				return new St.Icon({ icon_name: 'arch-lit-symbolic' });
			};
			// Take care of note leaving unneeded sources
			this._notifSource.connect('destroy', Lang.bind(this, function() {this._notifSource = null;}));
			Main.messageTray.add(this._notifSource);
		}
		let notification = null;
		// We do not want to have multiple notifications stacked
		// instead we will update previous
		if (this._notifSource.notifications.length == 0) {
			notification = new MessageTray.Notification(this._notifSource, title, message);
            if(!removeAction) {
            	notification.addAction( _('Update now') , Lang.bind(this, function() {this._updateNow()}) );
            }
		} else {
			notification = this._notifSource.notifications[0];
			notification.update( title, message, { clear: true });
		}
		notification.setTransient(TRANSIENT);
		this._notifSource.notify(notification);
	},


});

let fedoraupdateindicator;

function enable() {
	fedoraupdateindicator = new FedoraUpdateIndicator();
	Main.panel.addToStatusArea('FedoraUpdateIndicator', fedoraupdateindicator);
}

function disable() {
	fedoraUpdateindicator.destroy();
}
