/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the nsSessionStore component.
 *
 * The Initial Developer of the Original Code is
 * Simon Bünzli <zeniko@gmail.com>
 * Portions created by the Initial Developer are Copyright (C) 2006
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Dietrich Ayala <dietrich@mozilla.com>
 *   Ehsan Akhgari <ehsan.akhgari@gmail.com>
 *   Paul O’Shannessy <paul@oshannessy.com>
 *   Nils Maier <maierman@web.de>
 *   Michael Kraft <morac99-firefox@yahoo.com>
 *   Misak Khachatryan <misak.bugzilla@gmail.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/**
 * Session Storage and Restoration
 *
 * Overview
 * This service keeps track of a user's session, storing the various bits
 * required to return the browser to its current state. The relevant data is
 * stored in memory, and is periodically saved to disk in a file in the
 * profile directory. The service is started at first window load, in
 * delayedStartup, and will restore the session from the data received from
 * the nsSessionStartup service.
 */

/* :::::::: Constants and Helpers ::::::::::::::: */

const STATE_STOPPED = 0;
const STATE_RUNNING = 1;
const STATE_QUITTING = -1;

const STATE_STOPPED_STR = "stopped";
const STATE_RUNNING_STR = "running";

const PRIVACY_NONE = 0;
const PRIVACY_ENCRYPTED = 1;
const PRIVACY_FULL = 2;

const NOTIFY_WINDOWS_RESTORED = "sessionstore-windows-restored";
const NOTIFY_BROWSER_STATE_RESTORED = "sessionstore-browser-state-restored";

// global notifications observed
const OBSERVING = [
  "domwindowopened", "domwindowclosed",
  "quit-application-requested", "quit-application-granted",
  "browser-lastwindow-close-granted",
  "quit-application", "browser:purge-session-history"
];

/*
XUL Window properties to (re)store
Restored in restoreDimensions()
*/
const WINDOW_ATTRIBUTES = {
  width: "outerWidth",
  height: "outerHeight",
  screenX: "screenX",
  screenY: "screenY",
  sizemode: "windowState"
};

/*
Hideable window features to (re)store
Restored in restoreWindowFeatures()
*/
const WINDOW_HIDEABLE_FEATURES = [
  "menubar", "toolbar", "locationbar",
  "personalbar", "statusbar", "scrollbars"
];

/*
docShell capabilities to (re)store
Restored in restoreHistory()
eg: browser.docShell["allow" + aCapability] = false;

XXX keep these in sync with all the attributes starting
    with "allow" in /docshell/base/nsIDocShell.idl
*/
const CAPABILITIES = [
  "Subframes", "Plugins", "Javascript", "MetaRedirects", "Images",
  "DNSPrefetch", "Auth"
];

#ifndef XP_WIN
#define BROKEN_WM_Z_ORDER
#endif

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/NetUtil.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "cm",
  "@mozilla.org/cookiemanager;1", "nsICookieManager2");

#ifdef MOZ_CRASH_REPORTER
XPCOMUtils.defineLazyServiceGetter(this, "CrashReporter",
  "@mozilla.org/xre/app-info;1", "nsICrashReporter");
#endif

XPCOMUtils.defineLazyServiceGetter(this, "SecMan",
  "@mozilla.org/scriptsecuritymanager;1", "nsIScriptSecurityManager");

function debug(aMsg) {
  Services.console.logStringMessage("SessionStore: " + aMsg);
}

/* :::::::: The Service ::::::::::::::: */

function SessionStoreService() {
}

SessionStoreService.prototype = {
  classID: Components.ID("{d37ccdf1-496f-4135-9575-037180af010d}"),
  QueryInterface: XPCOMUtils.generateQI([Components.interfaces.nsISessionStore,
                                         Components.interfaces.nsIDOMEventListener,
                                         Components.interfaces.nsIObserver,
                                         Components.interfaces.nsISupportsWeakReference]),

  // xul:tab attributes to (re)store (extensions might want to hook in here);
  // the favicon is always saved for the about:sessionrestore page
  xulAttributes: ["image"],

  // set default load state
  _loadState: STATE_STOPPED,

  // minimal interval between two save operations (in milliseconds)
  _interval: 15000,

  // when crash recovery is disabled, session data is not written to disk
  _resume_from_crash: true,

  // During the initial restore and setBrowserState calls tracks the number of windows yet to be restored
  _restoreCount: 0,

  // whether a setBrowserState call is in progress
  _browserSetState: false,

  // time in milliseconds (Date.now()) when the session was last written to file
  _lastSaveTime: 0,

  // states for all currently opened windows
  _windows: {},

  // states for all recently closed windows
  _closedWindows: [],

  // not-"dirty" windows usually don't need to have their data updated
  _dirtyWindows: {},

  // collection of session states yet to be restored
  _statesToRestore: {},

  // counts the number of crashes since the last clean start
  _recentCrashes: 0,

  // whether the last window was closed and should be restored
  _restoreLastWindow: false,

/* ........ Global Event Handlers .............. */

  /**
   * Initialize the component
   */
  init: function sss_init(aWindow) {
    if (!aWindow || this._loadState == STATE_RUNNING) {
      // make sure that all browser windows which try to initialize
      // SessionStore are really tracked by it
      if (aWindow && (!aWindow.__SSi || !this._windows[aWindow.__SSi]))
        this.onLoad(aWindow);
      return;
    }

    this._prefBranch = Services.prefs.getBranch("browser.");
    this._prefBranch.QueryInterface(Components.interfaces.nsIPrefBranch2);

    OBSERVING.forEach(function(aTopic) {
      Services.obs.addObserver(this, aTopic, true);
    }, this);

    // get interval from prefs - used often, so caching/observing instead of fetching on-demand
    this._interval = this._prefBranch.getIntPref("sessionstore.interval");
    this._prefBranch.addObserver("sessionstore.interval", this, true);

    // get crash recovery state from prefs and allow for proper reaction to state changes
    this._resume_from_crash = this._prefBranch.getBoolPref("sessionstore.resume_from_crash");
    this._prefBranch.addObserver("sessionstore.resume_from_crash", this, true);

     // observe prefs changes so we can modify stored data to match
     this._prefBranch.addObserver("sessionstore.max_windows_undo", this, true);

    // this pref is only read at startup, so no need to observe it
    this._sessionhistory_max_entries =
      this._prefBranch.getIntPref("sessionhistory.max_entries");

    // get file references
    this._sessionFile = Services.dirsvc.get("ProfD", Components.interfaces.nsILocalFile);
    this._sessionFileBackup = this._sessionFile.clone();
    this._sessionFile.append("sessionstore.json");
    this._sessionFileBackup.append("sessionstore.bak");

    // get string containing session state
    var iniString;
    try {
      var ss = Components.classes["@mozilla.org/suite/sessionstartup;1"]
                         .getService(Components.interfaces.nsISessionStartup);
      if (ss.doRestore())
        iniString = ss.state;
    }
    catch(ex) { dump(ex + "\n"); } // no state to restore, which is ok

    if (iniString) {
      try {
        // parse the session state into JS objects
        this._initialState = JSON.parse(iniString);
      }
      catch (ex) { debug("The session file is invalid: " + ex); }

      let lastSessionCrashed =
        this._initialState && this._initialState.session && this._initialState.session.state &&
        this._initialState.session.state == STATE_RUNNING_STR;
       // if last session crashed, backup the session
       if (lastSessionCrashed) {
        this._recentCrashes = (this._initialState.session &&
                               this._initialState.session.recentCrashes || 0) + 1;

        if (this._needsRestorePage(this._initialState, this._recentCrashes)) {
          // replace the crashed session with a restore-page-only session
          let pageData = {
            url: "about:sessionrestore",
            formdata: { "#sessionData": iniString }
          };
          this._initialState = { windows: [{ tabs: [{ entries: [pageData] }] }] };
        }
       }
      // make sure that at least the first window doesn't have anything hidden
      if (this._initialState.windows[0]) {
        delete this._initialState.windows[0].hidden;
        // Since nothing is hidden in the first window, it cannot be a popup
        delete this._initialState.windows[0].isPopup;
      }
    }

    // remove the session data files if crash recovery is disabled
    if (!this._resume_from_crash)
      this._clearDisk();
    else { // create a backup if the session data file exists
      try {
        if (this._sessionFileBackup.exists())
          this._sessionFileBackup.remove(false);
        if (this._sessionFile.exists())
          this._sessionFile.copyTo(null, this._sessionFileBackup.leafName);
      }
      catch (ex) { Components.utils.reportError(ex); } // file was write-locked?
    }

    // at this point, we've as good as resumed the session, so we can
    // clear the resume_session_once flag, if it's set
    if (this._loadState != STATE_QUITTING &&
        this._prefBranch.getBoolPref("sessionstore.resume_session_once"))
      this._prefBranch.setBoolPref("sessionstore.resume_session_once", false);

    // As this is called at delayedStartup, restoration must be initiated here
    this.onLoad(aWindow);
  },

  /**
   * Called on application shutdown, after notifications:
   * quit-application-granted, quit-application
   */
  _uninit: function sss_uninit() {
    if (this._doResumeSession()) { // save all data for session resuming
      this.saveState(true);
    }
    else { // discard all session related data
      this._clearDisk();
    }
    // Make sure to break our cycle with the save timer
    if (this._saveTimer) {
      this._saveTimer.cancel();
      this._saveTimer = null;
    }
  },

  /**
   * Handle notifications
   */
  observe: function sss_observe(aSubject, aTopic, aData) {
    // for event listeners
    var _this = this;

    switch (aTopic) {
    case "domwindowopened": // catch new windows
      aSubject.addEventListener("load", function(aEvent) {
        aEvent.currentTarget.removeEventListener("load", arguments.callee, false);
        _this.onLoad(aEvent.currentTarget);
      }, false);
      break;
    case "domwindowclosed": // catch closed windows
      this.onClose(aSubject);
      break;
    case "quit-application-requested":
      // get a current snapshot of all windows
      this._forEachBrowserWindow(function(aWindow) {
        this._collectWindowData(aWindow);
      });
      this._dirtyWindows = [];
      break;
    case "quit-application-granted":
      // freeze the data at what we've got (ignoring closing windows)
      this._loadState = STATE_QUITTING;
      break;
    case "browser-lastwindow-close-granted":
      // last browser window is quitting.
      // remember to restore the last window when another browser window is openend
      // do not account for pref(resume_session_once) at this point, as it might be
      // set by another observer getting this notice after us
      this._restoreLastWindow = true;
      break;
    case "quit-application":
      if (aData == "restart" && !this._isSwitchingProfile())
        this._prefBranch.setBoolPref("sessionstore.resume_session_once", true);
      this._loadState = STATE_QUITTING; // just to be sure
      this._uninit();
      break;
    case "browser:purge-session-history": // catch sanitization
      let openWindows = {};
      this._forEachBrowserWindow(function(aWindow) {
        Array.forEach(aWindow.getBrowser().browsers, function(aBrowser) {
          delete aBrowser.__SS_data;
        });
        openWindows[aWindow.__SSi] = true;
      });
      // also clear all data about closed tabs and windows
      for (let ix in this._windows) {
        if (ix in openWindows)
          this._windows[ix]._closedTabs = [];
        else
          delete this._windows[ix];
      }
      // also clear all data about closed windows
      this._closedWindows = [];
      this._clearDisk();
      // give the tabbrowsers a chance to clear their histories first
      var win = this._getMostRecentBrowserWindow();
      if (win)
        win.setTimeout(function() { _this.saveState(true); }, 0);
      else if (this._loadState == STATE_RUNNING)
        this.saveState(true);
      break;
    case "nsPref:changed": // catch pref changes
      switch (aData) {
      case "sessionstore.max_windows_undo":
        this._capClosedWindows();
        break;
      case "sessionstore.interval":
        this._interval = this._prefBranch.getIntPref("sessionstore.interval");
        // reset timer and save
        if (this._saveTimer) {
          this._saveTimer.cancel();
          this._saveTimer = null;
        }
        this.saveStateDelayed(null, -1);
        break;
      case "sessionstore.resume_from_crash":
        this._resume_from_crash = this._prefBranch.getBoolPref("sessionstore.resume_from_crash");
        // either create the file with crash recovery information or remove it
        // (when _loadState is not STATE_RUNNING, that file is used for session resuming instead)
        if (this._resume_from_crash)
          this.saveState(true);
        else if (this._loadState == STATE_RUNNING)
          this._clearDisk();
        break;
      }
      break;
    case "timer-callback": // timer call back for delayed saving
      this._saveTimer = null;
      this.saveState();
      break;
    }
  },

/* ........ Window Event Handlers .............. */

  /**
   * Implement nsIDOMEventListener for handling various window and tab events
   */
  handleEvent: function sss_handleEvent(aEvent) {
    var win = aEvent.currentTarget.ownerDocument.defaultView;
    switch (aEvent.type) {
      case "load":
        // If __SS_restore_data is set, then we need to restore the document
        // (form data, scrolling, etc.). This will only happen when a tab is
        // first restored.
        if (aEvent.currentTarget.__SS_restore_data)
          this.restoreDocument(win, aEvent.currentTarget, aEvent);
        // We still need to call onTabLoad, so fall through to "pageshow" case.
      case "pageshow":
        this.onTabLoad(win, aEvent.currentTarget, aEvent);
        break;
      case "change":
      case "input":
      case "DOMAutoComplete":
        this.onTabInput(win, aEvent.currentTarget);
        break;
      case "TabOpen":
      case "TabClose":
        let browser = aEvent.originalTarget.linkedBrowser;
        if (aEvent.type == "TabOpen") {
          this.onTabAdd(win, browser);
        }
        else {
          // aEvent.detail determines if the tab was closed by moving to a different window
          if (!aEvent.detail)
            this.onTabClose(win, aEvent.originalTarget);
          this.onTabRemove(win, browser);
        }
        break;
      case "TabSelect":
        this.onTabSelect(win);
        break;
    }
  },

  /**
   * If it's the first window load since app start...
   * - determine if we're reloading after a crash or a forced-restart
   * - restore window state
   * - restart downloads
   * Set up event listeners for this window's tabs
   * @param aWindow
   *        Window reference
   */
  onLoad: function sss_onLoad(aWindow) {
    // return if window has already been initialized
    if (aWindow && aWindow.__SSi && this._windows[aWindow.__SSi])
      return;

    // ignore non-browser windows and windows opened while shutting down
    if (aWindow.document.documentElement.getAttribute("windowtype") != "navigator:browser" ||
        this._loadState == STATE_QUITTING)
      return;

    // assign it a unique identifier (timestamp)
    aWindow.__SSi = "window" + Date.now();

    // and create its data object
    this._windows[aWindow.__SSi] = { tabs: [], selected: 0, _closedTabs: [] };
    if (!aWindow.toolbar.visible)
      this._windows[aWindow.__SSi].isPopup = true;

    // perform additional initialization when the first window is loading
    if (this._loadState == STATE_STOPPED) {
      this._loadState = STATE_RUNNING;
      this._lastSaveTime = Date.now();

      // restore a crashed session resp. resume the last session if requested
      if (this._initialState) {
        // make sure that the restored tabs are first in the window
        this._initialState._firstTabs = true;
        this._restoreCount = this._initialState.windows ? this._initialState.windows.length : 0;
        this.restoreWindow(aWindow, this._initialState, this._isCmdLineEmpty(aWindow));
        delete this._initialState;

        // _loadState changed from "stopped" to "running"
        // force a save operation so that crashes happening during startup are correctly counted
        this.saveState(true);
      }
      else {
        // Nothing to restore, notify observers things are complete.
        Services.obs.notifyObservers(aWindow, NOTIFY_WINDOWS_RESTORED, "");

        // the next delayed save request should execute immediately
        this._lastSaveTime -= this._interval;
      }
    }
    // this window was opened by _openWindowWithState
    else if (!this._isWindowLoaded(aWindow)) {
      let followUp = this._statesToRestore[aWindow.__SS_restoreID].windows.length == 1;
      this.restoreWindow(aWindow, this._statesToRestore[aWindow.__SS_restoreID], true, followUp);
    }
    else if (this._restoreLastWindow && aWindow.toolbar.visible &&
             this._closedWindows.length && this._doResumeSession()) {
      // default to the most-recently closed window
      // don't use popup windows
      let state = null;
      this._closedWindows = this._closedWindows.filter(function(aWinState) {
        if (!state && !aWinState.isPopup) {
          state = aWinState;
          return false;
        }
        return true;
      });
      if (state) {
        delete state.hidden;
        state = { windows: [state] };
        this._restoreCount = 1;
        this.restoreWindow(aWindow, state, this._isCmdLineEmpty(aWindow));
      }
      // we actually restored the session just now.
      this._prefBranch.setBoolPref("sessionstore.resume_session_once", false);
    }
    if (this._restoreLastWindow && aWindow.toolbar.visible) {
      // always reset (if not a popup window)
      // we don't want to restore a window directly after, for example,
      // undoCloseWindow was executed.
      this._restoreLastWindow = false;
    }

    var tabbrowser = aWindow.getBrowser();

    // add tab change listeners to all already existing tabs
    for (let i = 0; i < tabbrowser.browsers.length; i++) {
      this.onTabAdd(aWindow, tabbrowser.browsers[i], true);
    }
    // notification of tab add/remove/selection
    tabbrowser.addEventListener("TabOpen", this, true);
    tabbrowser.addEventListener("TabClose", this, true);
    tabbrowser.addEventListener("TabSelect", this, true);
  },

  /**
   * On window close...
   * - remove event listeners from tabs
   * - save all window data
   * @param aWindow
   *        Window reference
   */
  onClose: function sss_onClose(aWindow) {
    // this window was about to be restored - conserve its original data, if any
    let isFullyLoaded = this._isWindowLoaded(aWindow);
    if (!isFullyLoaded) {
      if (!aWindow.__SSi)
        aWindow.__SSi = "window" + Date.now();
      this._windows[aWindow.__SSi] = this._statesToRestore[aWindow.__SS_restoreID];
      delete this._statesToRestore[aWindow.__SS_restoreID];
      delete aWindow.__SS_restoreID;
    }

    // ignore windows not tracked by SessionStore
    if (!aWindow.__SSi || !this._windows[aWindow.__SSi]) {
      return;
    }

    if (this.windowToFocus && this.windowToFocus == aWindow) {
      delete this.windowToFocus;
    }

    var tabbrowser = aWindow.getBrowser();

    tabbrowser.removeEventListener("TabOpen", this, true);
    tabbrowser.removeEventListener("TabClose", this, true);
    tabbrowser.removeEventListener("TabSelect", this, true);

    let winData = this._windows[aWindow.__SSi];
    if (this._loadState == STATE_RUNNING) { // window not closed during a regular shut-down
      // update all window data for a last time
      this._collectWindowData(aWindow);

      if (isFullyLoaded) {
        winData.title = aWindow.content.document.title || tabbrowser.selectedTab.label;
        winData.title = this._replaceLoadingTitle(winData.title, tabbrowser,
                                                  tabbrowser.selectedTab);
        this._updateCookies([winData]);
      }

      // save the window if it has multiple tabs or a single tab with entries
      if (winData.tabs.length > 1 ||
          (winData.tabs.length == 1 && winData.tabs[0].entries.length > 0)) {
        this._closedWindows.unshift(winData);
        this._capClosedWindows();
      }

      // clear this window from the list
      delete this._windows[aWindow.__SSi];

      // save the state without this window to disk
      this.saveStateDelayed();
    }

    for (let i = 0; i < tabbrowser.browsers.length; i++) {
      this.onTabRemove(aWindow, tabbrowser.browsers[i], true);
    }

    // cache the window state until the window is completely gone
    aWindow.__SS_dyingCache = winData;

    delete aWindow.__SSi;
  },

  /**
   * set up listeners for a new tab
   * @param aWindow
   *        Window reference
   * @param aBrowser
   *        Browser reference
   * @param aNoNotification
   *        bool Do not save state if we're updating an existing tab
   */
  onTabAdd: function sss_onTabAdd(aWindow, aBrowser, aNoNotification) {
    aBrowser.addEventListener("load", this, true);
    aBrowser.addEventListener("pageshow", this, true);
    aBrowser.addEventListener("change", this, true);
    aBrowser.addEventListener("input", this, true);
    aBrowser.addEventListener("DOMAutoComplete", this, true);

    if (!aNoNotification) {
      this.saveStateDelayed(aWindow);
    }

    this._updateCrashReportURL(aWindow);
  },

  /**
   * remove listeners for a tab
   * @param aWindow
   *        Window reference
   * @param aBrowser
   *        Browser reference
   * @param aNoNotification
   *        bool Do not save state if we're updating an existing tab
   */
  onTabRemove: function sss_onTabRemove(aWindow, aBrowser, aNoNotification) {
    aBrowser.removeEventListener("load", this, true);
    aBrowser.removeEventListener("pageshow", this, true);
    aBrowser.removeEventListener("change", this, true);
    aBrowser.removeEventListener("input", this, true);
    aBrowser.removeEventListener("DOMAutoComplete", this, true);

    delete aBrowser.__SS_data;

    if (!aNoNotification) {
      this.saveStateDelayed(aWindow);
    }
  },

  /**
   * When a tab closes, collect its properties
   * @param aWindow
   *        Window reference
   * @param aTab
   *        Tab reference
   */
  onTabClose: function sss_onTabClose(aWindow, aTab) {
    // notify the tabbrowser that the tab state will be retrieved for the last time
    // (so that extension authors can easily set data on soon-to-be-closed tabs)
    var event = aWindow.document.createEvent("Events");
    event.initEvent("SSTabClosing", true, false);
    aTab.dispatchEvent(event);

    var maxTabsUndo = this._prefBranch.getIntPref("sessionstore.max_tabs_undo");
    // don't update our internal state if we don't have to
    if (maxTabsUndo == 0) {
      return;
    }

    // make sure that the tab related data is up-to-date
    var tabState = this._collectTabData(aTab);
    this._updateTextAndScrollDataForTab(aWindow, aTab.linkedBrowser, tabState);

    // store closed-tab data for undo
    if (tabState.entries.length > 0) {
      aTab.tabData = { state: tabState };
      var closedTabs = this._windows[aWindow.__SSi]._closedTabs;
      closedTabs.unshift(aTab.tabData);
      if (closedTabs.length > maxTabsUndo)
        closedTabs.length = maxTabsUndo;
    };
  },

  /**
   * When a tab loads, save state.
   * @param aWindow
   *        Window reference
   * @param aBrowser
   *        Browser reference
   * @param aEvent
   *        Event obj
   */
  onTabLoad: function sss_onTabLoad(aWindow, aBrowser, aEvent) {
    // react on "load" and solitary "pageshow" events (the first "pageshow"
    // following "load" is too late for deleting the data caches)
    if (aEvent.type != "load" && !aEvent.persisted) {
      return;
    }

    delete aBrowser.__SS_data;
    this.saveStateDelayed(aWindow);

    // attempt to update the current URL we send in a crash report
    this._updateCrashReportURL(aWindow);
  },

  /**
   * Called when a browser sends the "input" notification
   * @param aWindow
   *        Window reference
   * @param aBrowser
   *        Browser reference
   */
  onTabInput: function sss_onTabInput(aWindow, aBrowser) {
    if (aBrowser.__SS_data)
      delete aBrowser.__SS_data._formDataSaved;

    this.saveStateDelayed(aWindow, 3000);
  },

  /**
   * When a tab is selected, save session data
   * @param aWindow
   *        Window reference
   */
  onTabSelect: function sss_onTabSelect(aWindow) {
    if (this._loadState == STATE_RUNNING) {
      this._windows[aWindow.__SSi].selected = aWindow.getBrowser().tabContainer.selectedIndex;

      // attempt to update the current URL we send in a crash report
      this._updateCrashReportURL(aWindow);
    }
  },

/* ........ nsISessionStore API .............. */

  getBrowserState: function sss_getBrowserState() {
    return this._toJSONString(this._getCurrentState());
  },

  setBrowserState: function sss_setBrowserState(aState) {
    this._handleClosedWindows();

    try {
      var state = JSON.parse(aState);
    }
    catch (ex) { /* invalid state object - don't restore anything */ }
    if (!state || !state.windows)
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    this._browserSetState = true;

    var window = this._getMostRecentBrowserWindow();
    if (!window) {
      this._restoreCount = 1;
      this._openWindowWithState(state);
      return;
    }

    // close all other browser windows
    this._forEachBrowserWindow(function(aWindow) {
      if (aWindow != window) {
        aWindow.close();
      }
    });

    // make sure closed window data isn't kept
    this._closedWindows = [];

    // determine how many windows are meant to be restored
    this._restoreCount = state.windows ? state.windows.length : 0;

    // restore to the given state
    this.restoreWindow(window, state, true);
  },

  getWindowState: function sss_getWindowState(aWindow) {
    if (!aWindow.__SSi && !aWindow.__SS_dyingCache)
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    if (!aWindow.__SSi)
      return this._toJSONString({ windows: [aWindow.__SS_dyingCache] });
    return this._toJSONString(this._getWindowState(aWindow));
  },

  setWindowState: function sss_setWindowState(aWindow, aState, aOverwrite) {
    if (!aWindow.__SSi)
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    this.restoreWindow(aWindow, aState, aOverwrite);
  },

  getTabState: function sss_getTabState(aTab) {
    if (!aTab.ownerDocument || !aTab.ownerDocument.defaultView.__SSi)
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    var tabState = this._collectTabData(aTab);

    var window = aTab.ownerDocument.defaultView;
    this._updateTextAndScrollDataForTab(window, aTab.linkedBrowser, tabState);

    return this._toJSONString(tabState);
  },

  setTabState: function sss_setTabState(aTab, aState) {
    var tabState = JSON.parse(aState);
    if (!tabState.entries || !aTab.ownerDocument || !aTab.ownerDocument.defaultView.__SSi)
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    var window = aTab.ownerDocument.defaultView;
    this.restoreHistoryPrecursor(window, [aTab], [tabState], 0, 0, 0);
  },

  duplicateTab: function sss_duplicateTab(aWindow, aTab) {
    if (!aTab.ownerDocument || !aTab.ownerDocument.defaultView.__SSi ||
        !aWindow.getBrowser)
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    var tabState = this._collectTabData(aTab, true);
    var sourceWindow = aTab.ownerDocument.defaultView;
    this._updateTextAndScrollDataForTab(sourceWindow, aTab.linkedBrowser, tabState, true);

    var newTab = aWindow.getBrowser().addTab();
    this.restoreHistoryPrecursor(aWindow, [newTab], [tabState], 0, 0, 0);

    return newTab;
  },

  getClosedTabCount: function sss_getClosedTabCount(aWindow) {
    if (!aWindow.__SSi && aWindow.__SS_dyingCache)
      return aWindow.__SS_dyingCache._closedTabs.length;

    if (!aWindow.__SSi)
      // XXXzeniko shouldn't we throw here?
      return 0; // not a browser window, or not otherwise tracked by SS.

    var closedTabs = this._windows[aWindow.__SSi]._closedTabs;
    closedTabs = closedTabs.concat(aWindow.getBrowser().savedBrowsers);
    closedTabs = closedTabs.filter(function(aTabData, aIndex, aArray) {
      return aArray.indexOf(aTabData) == aIndex;
    });
    return closedTabs.length;
  },

  getClosedTabData: function sss_getClosedTabData(aWindow) {
    if (!aWindow.__SSi && !aWindow.__SS_dyingCache)
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    if (!aWindow.__SSi)
      return this._toJSONString(aWindow.__SS_dyingCache._closedTabs);

    var closedTabs = this._windows[aWindow.__SSi]._closedTabs;
    closedTabs = closedTabs.concat(aWindow.getBrowser().savedBrowsers);
    closedTabs = closedTabs.filter(function(aTabData, aIndex, aArray) {
      return aArray.indexOf(aTabData) == aIndex;
    });
    return this._toJSONString(closedTabs);
  },

  undoCloseTab: function sss_undoCloseTab(aWindow, aIndex) {
    if (!aWindow.__SSi)
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    var closedTabs = this._windows[aWindow.__SSi]._closedTabs;
    if (!(aIndex in closedTabs))
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    // fetch the data of closed tab, while removing it from the array
    let closedTab = closedTabs.splice(aIndex, 1)[0];
    var browser = aWindow.getBrowser();
    var index = browser.savedBrowsers.indexOf(closedTab);
    if (index != -1)
      // SeaMonkey has its own undoclosetab functionality
      return browser.restoreTab(index);

    // create a new tab
    var browser = aWindow.getBrowser();
    var tab = browser.addTab();

    // restore the tab's position
    browser.moveTabTo(tab, closedTab.pos);

    // restore tab content
    this.restoreHistoryPrecursor(aWindow, [tab], [closedTab.state], 1, 0, 0);

    // focus the tab's content area
    var content = browser.getBrowserForTab(tab).contentWindow;
    aWindow.setTimeout(function() { content.focus(); }, 0);

    return tab;
  },

  forgetClosedTab: function sss_forgetClosedTab(aWindow, aIndex) {
    if (!aWindow.__SSi)
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    var closedTabs = this._windows[aWindow.__SSi]._closedTabs;
    if (!(aIndex in closedTabs))
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);

    // remove closed tab from the array
    var closedTab = closedTabs.splice(aIndex, 1)[0];
    var browser = aWindow.getBrowser();
    var index = browser.savedBrowsers.indexOf(closedTab);
    if (index != -1)
      browser.forgetSavedBrowser(aIndex);
  },

  getClosedWindowCount: function sss_getClosedWindowCount() {
    return this._closedWindows.length;
  },

  getClosedWindowData: function sss_getClosedWindowData() {
    return this._toJSONString(this._closedWindows);
  },

  undoCloseWindow: function sss_undoCloseWindow(aIndex) {
    if (!(aIndex in this._closedWindows))
      return null;

    // reopen the window
    let state = { windows: this._closedWindows.splice(aIndex, 1) };
    let window = this._openWindowWithState(state);
    this.windowToFocus = window;
    return window;
  },

  getWindowValue: function sss_getWindowValue(aWindow, aKey) {
    if (aWindow.__SSi) {
      var data = this._windows[aWindow.__SSi].extData || {};
      return data[aKey] || "";
    }
    if (aWindow.__SS_dyingCache) {
      data = aWindow.__SS_dyingCache.extData || {};
      return data[aKey] || "";
    }
    throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);
  },

  setWindowValue: function sss_setWindowValue(aWindow, aKey, aStringValue) {
    if (aWindow.__SSi) {
      if (!this._windows[aWindow.__SSi].extData) {
        this._windows[aWindow.__SSi].extData = {};
      }
      this._windows[aWindow.__SSi].extData[aKey] = aStringValue;
      this.saveStateDelayed(aWindow);
    }
    else {
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);
    }
  },

  deleteWindowValue: function sss_deleteWindowValue(aWindow, aKey) {
    if (aWindow.__SSi && this._windows[aWindow.__SSi].extData &&
        this._windows[aWindow.__SSi].extData[aKey])
      delete this._windows[aWindow.__SSi].extData[aKey];
    else
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);
  },

  getTabValue: function sss_getTabValue(aTab, aKey) {
    var data = aTab.__SS_extdata || {};
    return data[aKey] || "";
  },

  setTabValue: function sss_setTabValue(aTab, aKey, aStringValue) {
    if (!aTab.__SS_extdata) {
      aTab.__SS_extdata = {};
    }
    aTab.__SS_extdata[aKey] = aStringValue;
    this.saveStateDelayed(aTab.ownerDocument.defaultView);
  },

  deleteTabValue: function sss_deleteTabValue(aTab, aKey) {
    if (aTab.__SS_extdata && aTab.__SS_extdata[aKey])
      delete aTab.__SS_extdata[aKey];
    else
      throw (Components.returnCode = Components.results.NS_ERROR_INVALID_ARG);
  },

  persistTabAttribute: function sss_persistTabAttribute(aName) {
    if (this.xulAttributes.indexOf(aName) != -1)
      return; // this attribute is already being tracked

    this.xulAttributes.push(aName);
    this.saveStateDelayed();
  },

  doRestoreLastWindow: function sss_doRestoreLastWindow() {
    let state = null;
    this._closedWindows.forEach(function(aWinState) {
      if (!state && !aWinState.isPopup) {
        state = aWinState;
      }
    });
    return (this._restoreLastWindow && state &&
            this._doResumeSession());
  },

/* ........ Saving Functionality .............. */

  /**
   * Store all session data for a window
   * @param aWindow
   *        Window reference
   */
  _saveWindowHistory: function sss_saveWindowHistory(aWindow) {
    var tabbrowser = aWindow.getBrowser();
    var tabs = tabbrowser.tabs;
    var tabsData = this._windows[aWindow.__SSi].tabs = [];

    for (var i = 0; i < tabs.length; i++)
      tabsData.push(this._collectTabData(tabs[i]));

    this._windows[aWindow.__SSi].selected = tabbrowser.mTabBox.selectedIndex + 1;
  },

  /**
   * Collect data related to a single tab
   * @param aTab
   *        tabbrowser tab
   * @param aFullData
   *        always return privacy sensitive data (use with care)
   * @returns object
   */
  _collectTabData: function sss_collectTabData(aTab, aFullData) {
    var tabData = { entries: [] };
    var browser = aTab.linkedBrowser;

    if (!browser || !browser.currentURI)
      // can happen when calling this function right after .addTab()
      return tabData;
    else if (browser.__SS_data && browser.__SS_data._tabStillLoading)
      // use the data to be restored when the tab hasn't been completely loaded
      return browser.__SS_data;

    var history = null;
    try {
      history = browser.sessionHistory;
    }
    catch (ex) { } // this could happen if we catch a tab during (de)initialization

    // XXXzeniko anchor navigation doesn't reset __SS_data, so we could reuse
    //           data even when we shouldn't (e.g. Back, different anchor)
    if (history && browser.__SS_data &&
        browser.__SS_data.entries[history.index] &&
        history.index < this._sessionhistory_max_entries - 1 && !aFullData) {
      tabData = browser.__SS_data;
      tabData.index = history.index + 1;
    }
    else if (history && history.count > 0) {
      for (var j = 0; j < history.count; j++)
        tabData.entries.push(this._serializeHistoryEntry(history.getEntryAtIndex(j, false),
                                                         aFullData));
      tabData.index = history.index + 1;

      // make sure not to cache privacy sensitive data which shouldn't get out
      if (!aFullData)
        browser.__SS_data = tabData;
    }
    else if (browser.currentURI.spec != "about:blank" ||
             browser.contentDocument.body.hasChildNodes()) {
      tabData.entries[0] = { url: browser.currentURI.spec };
      tabData.index = 1;
    }

    // If there is a userTypedValue set, then either the user has typed something
    // in the URL bar, or a new tab was opened with a URI to load. userTypedClear
    // is used to indicate whether the tab was in some sort of loading state with
    // userTypedValue.
    if (browser.userTypedValue) {
      tabData.userTypedValue = browser.userTypedValue;
      tabData.userTypedClear = browser.userTypedClear;
    }

    var disallow = [];
    for (var i = 0; i < CAPABILITIES.length; i++)
      if (!browser.docShell["allow" + CAPABILITIES[i]])
        disallow.push(CAPABILITIES[i]);
    if (disallow.length > 0)
      tabData.disallow = disallow.join(",");
    else if (tabData.disallow)
      delete tabData.disallow;

    if (this.xulAttributes.length > 0) {
      tabData.attributes = {};
      Array.forEach(aTab.attributes, function(aAttr) {
        if (this.xulAttributes.indexOf(aAttr.name) > -1)
          tabData.attributes[aAttr.name] = aAttr.value;
      }, this);
    }

    if (aTab.__SS_extdata)
      tabData.extData = aTab.__SS_extdata;
    else if (tabData.extData)
      delete tabData.extData;

    if (history && browser.docShell instanceof Components.interfaces.nsIDocShell)
      this._serializeSessionStorage(tabData, history, browser.docShell, aFullData);

    return tabData;
  },

  /**
   * Get an object that is a serialized representation of a History entry
   * Used for data storage
   * @param aEntry
   *        nsISHEntry instance
   * @param aFullData
   *        always return privacy sensitive data (use with care)
   * @returns object
   */
  _serializeHistoryEntry: function sss_serializeHistoryEntry(aEntry, aFullData) {
    var entry = { url: aEntry.URI.spec };

    if (aEntry.title && aEntry.title != entry.url) {
      entry.title = aEntry.title;
    }
    if (aEntry.isSubFrame) {
      entry.subframe = true;
    }
    if (!(aEntry instanceof Components.interfaces.nsISHEntry)) {
      return entry;
    }

    var cacheKey = aEntry.cacheKey;
    if (cacheKey && cacheKey instanceof Components.interfaces.nsISupportsPRUint32 &&
        cacheKey.data != 0) {
      // XXXbz would be better to have cache keys implement
      // nsISerializable or something.
      entry.cacheKey = cacheKey.data;
    }
    entry.ID = aEntry.ID;

    if (aEntry.referrerURI)
      entry.referrer = aEntry.referrerURI.spec;

    if (aEntry.contentType)
      entry.contentType = aEntry.contentType;

    var x = {}, y = {};
    aEntry.getScrollPosition(x, y);
    if (x.value != 0 || y.value != 0)
      entry.scroll = x.value + "," + y.value;

    try {
      var prefPostdata = this._prefBranch.getIntPref("sessionstore.postdata");
      if (aEntry.postData && (aFullData ||
            prefPostdata && this._checkPrivacyLevel(aEntry.URI.schemeIs("https")))) {
        aEntry.postData.QueryInterface(Components.interfaces.nsISeekableStream)
                       .seek(Components.interfaces.nsISeekableStream.NS_SEEK_SET, 0);
        var stream = Components.classes["@mozilla.org/binaryinputstream;1"]
                               .createInstance(Components.interfaces.nsIBinaryInputStream);
        stream.setInputStream(aEntry.postData);
        var postBytes = stream.readByteArray(stream.available());
        var postdata = String.fromCharCode.apply(null, postBytes);
        if (aFullData || prefPostdata == -1 ||
            postdata.replace(/^(Content-.*\r\n)+(\r\n)*/, "").length <=
              prefPostdata) {
          // We can stop doing base64 encoding once our serialization into JSON
          // is guaranteed to handle all chars in strings, including embedded
          // nulls.
          entry.postdata_b64 = btoa(postdata);
        }
      }
    }
    catch (ex) { debug(ex); } // POSTDATA is tricky - especially since some extensions don't get it right

    if (aEntry.owner) {
      // Not catching anything specific here, just possible errors
      // from writeCompoundObject and the like.
      try {
        var binaryStream = Components.classes["@mozilla.org/binaryoutputstream;1"]
                                     .createInstance(Components.interfaces.nsIObjectOutputStream);
        var pipe = Components.classes["@mozilla.org/pipe;1"].createInstance(Components.interfaces.nsIPipe);
        pipe.init(false, false, 0, 0xffffffff, null);
        binaryStream.setOutputStream(pipe.outputStream);
        binaryStream.writeCompoundObject(aEntry.owner, Components.interfaces.nsISupports, true);
        binaryStream.close();

        // Now we want to read the data from the pipe's input end and encode it.
        var scriptableStream = Components.classes["@mozilla.org/binaryinputstream;1"]
                                         .createInstance(Components.interfaces.nsIBinaryInputStream);
        scriptableStream.setInputStream(pipe.inputStream);
        var ownerBytes =
          scriptableStream.readByteArray(scriptableStream.available());
        // We can stop doing base64 encoding once our serialization into JSON
        // is guaranteed to handle all chars in strings, including embedded
        // nulls.
        entry.owner_b64 = btoa(String.fromCharCode.apply(null, ownerBytes));
      }
      catch (ex) { debug(ex); }
    }

    if (aEntry.docIdentifier) {
      entry.docIdentifier = aEntry.docIdentifier;
    }

    if (aEntry.stateData) {
      entry.stateData = aEntry.stateData;
    }

    if (!(aEntry instanceof Components.interfaces.nsISHContainer)) {
      return entry;
    }

    if (aEntry.childCount > 0) {
      entry.children = [];
      for (var i = 0; i < aEntry.childCount; i++) {
        var child = aEntry.GetChildAt(i);
        if (child) {
          entry.children.push(this._serializeHistoryEntry(child, aFullData));
        }
        else { // to maintain the correct frame order, insert a dummy entry
          entry.children.push({ url: "about:blank" });
        }
        // don't try to restore framesets containing wyciwyg URLs (cf. bug 424689 and bug 450595)
        if (/^wyciwyg:\/\//.test(entry.children[i].url)) {
          delete entry.children;
          break;
        }
      }
    }

    return entry;
  },

  /**
   * Updates all sessionStorage "super cookies"
   * @param aTabData
   *        The data object for a specific tab
   * @param aHistory
   *        That tab's session history
   * @param aDocShell
   *        That tab's docshell (containing the sessionStorage)
   * @param aFullData
   *        always return privacy sensitive data (use with care)
   */
  _serializeSessionStorage:
    function sss_serializeSessionStorage(aTabData, aHistory, aDocShell, aFullData) {
    let storageData = {};
    let hasContent = false;

    for (let i = 0; i < aHistory.count; i++) {
      let uri = aHistory.getEntryAtIndex(i, false).URI;
      // sessionStorage is saved per origin (cf. nsDocShell::GetSessionStorageForURI)
      let domain = uri.spec;
      try {
        if (uri.host)
          domain = uri.prePath;
      }
      catch (ex) { /* this throws for host-less URIs (such as about: or jar:) */ }
      if (storageData[domain] || !(aFullData || this._checkPrivacyLevel(uri.schemeIs("https"))))
        continue;

      let storage, storageItemCount = 0;
      try {
        var principal = SecMan.getCodebasePrincipal(uri);

        // Using getSessionStorageForPrincipal instead of getSessionStorageForURI
        // just to be able to pass aCreate = false, that avoids creation of the
        // sessionStorage object for the page earlier than the page really
        // requires it. It was causing problems while accessing a storage when
        // a page later changed its domain.
        storage = aDocShell.getSessionStorageForPrincipal(principal, "", false);
        if (storage)
          storageItemCount = storage.length;
      }
      catch (ex) { /* sessionStorage might throw if it's turned off, see bug 458954 */ }
      if (storageItemCount == 0)
        continue;

      let data = storageData[domain] = {};
      for (let j = 0; j < storageItemCount; j++) {
        try {
          let key = storage.key(j);
          let item = storage.getItem(key);
          data[key] = item;
        }
        catch (ex) { /* XXXzeniko this currently throws for secured items (cf. bug 442048) */ }
      }
      hasContent = true;
    }

    if (hasContent)
      aTabData.storage = storageData;
  },

  /**
   * go through all tabs and store the current scroll positions
   * and innerHTML content of WYSIWYG editors
   * @param aWindow
   *        Window reference
   */
  _updateTextAndScrollData: function sss_updateTextAndScrollData(aWindow) {
    var browsers = aWindow.getBrowser().browsers;
    for (var i = 0; i < browsers.length; i++) {
      try {
        var tabData = this._windows[aWindow.__SSi].tabs[i];
        if (browsers[i].__SS_data &&
            browsers[i].__SS_data._tabStillLoading)
          continue; // ignore incompletely initialized tabs
        this._updateTextAndScrollDataForTab(aWindow, browsers[i], tabData);
      }
      catch (ex) { debug(ex); } // get as much data as possible, ignore failures (might succeed the next time)
    }
  },

  /**
   * go through all frames and store the current scroll positions
   * and innerHTML content of WYSIWYG editors
   * @param aWindow
   *        Window reference
   * @param aBrowser
   *        single browser reference
   * @param aTabData
   *        tabData object to add the information to
   * @param aFullData
   *        always return privacy sensitive data (use with care)
   */
  _updateTextAndScrollDataForTab:
    function sss_updateTextAndScrollDataForTab(aWindow, aBrowser, aTabData, aFullData) {
    var tabIndex = (aTabData.index || aTabData.entries.length) - 1;
    // entry data needn't exist for tabs just initialized with an incomplete session state
    if (!aTabData.entries[tabIndex])
      return;

    let selectedPageStyle = aBrowser.markupDocumentViewer.authorStyleDisabled ? "_nostyle" :
                            this._getSelectedPageStyle(aBrowser.contentWindow);
    if (selectedPageStyle)
      aTabData.pageStyle = selectedPageStyle;
    else if (aTabData.pageStyle)
      delete aTabData.pageStyle;

    this._updateTextAndScrollDataForFrame(aWindow, aBrowser.contentWindow,
                                          aTabData.entries[tabIndex],
                                          !aTabData._formDataSaved, aFullData);
    aTabData._formDataSaved = true;
    if (aBrowser.currentURI.spec == "about:config")
      aTabData.entries[tabIndex].formdata = {
        "#textbox": aBrowser.contentDocument.getElementById("textbox").wrappedJSObject.value
      };
  },

  /**
   * go through all subframes and store all form data, the current
   * scroll positions and innerHTML content of WYSIWYG editors
   * @param aWindow
   *        Window reference
   * @param aContent
   *        frame reference
   * @param aData
   *        part of a tabData object to add the information to
   * @param aUpdateFormData
   *        update all form data for this tab
   * @param aFullData
   *        always return privacy sensitive data (use with care)
   */
  _updateTextAndScrollDataForFrame:
    function sss_updateTextAndScrollDataForFrame(aWindow, aContent, aData,
                                                 aUpdateFormData, aFullData) {
    for (var i = 0; i < aContent.frames.length; i++) {
      if (aData.children && aData.children[i])
        this._updateTextAndScrollDataForFrame(aWindow, aContent.frames[i],
                                              aData.children[i], aUpdateFormData, aFullData);
    }
    var isHTTPS = this._getURIFromString((aContent.parent || aContent).
                                         document.location.href).schemeIs("https");
    if (aFullData || this._checkPrivacyLevel(isHTTPS) ||
        aContent.top.document.location.href == "about:sessionrestore") {
      if (aFullData || aUpdateFormData) {
        let formData = this._collectFormDataForFrame(aContent.document);
        if (formData)
          aData.formdata = formData;
        else if (aData.formdata)
          delete aData.formdata;
      }

      // designMode is undefined e.g. for XUL documents (as about:config)
      if ((aContent.document.designMode || "") == "on") {
        if (aData.innerHTML === undefined && !aFullData) {
          // we get no "input" events from iframes - listen for keypress here
          let _this = this;
          aContent.addEventListener("keypress", function(aEvent) {
            _this.saveStateDelayed(aWindow, 3000);
          }, true);
        }
        aData.innerHTML = aContent.document.body.innerHTML;
      }
    }

    // get scroll position from nsIDOMWindowUtils, since it allows avoiding a
    // flush of layout
    let domWindowUtils = aContent.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                                 .getInterface(Components.interfaces.nsIDOMWindowUtils);
    let scrollX = {}, scrollY = {};
    domWindowUtils.getScrollXY(false, scrollX, scrollY);
    aData.scroll = scrollX.value + "," + scrollY.value;
  },

  /**
   * determine the title of the currently enabled style sheet (if any)
   * and recurse through the frameset if necessary
   * @param   aContent is a frame reference
   * @returns the title style sheet determined to be enabled (empty string if none)
   */
  _getSelectedPageStyle: function sss_getSelectedPageStyle(aContent) {
    const forScreen = /(?:^|,)\s*(?:all|screen)\s*(?:,|$)/i;
    for (let i = 0; i < aContent.document.styleSheets.length; i++) {
      let ss = aContent.document.styleSheets[i];
      let media = ss.media.mediaText;
      if (!ss.disabled && ss.title && (!media || forScreen.test(media)))
        return ss.title
    }
    for (let i = 0; i < aContent.frames.length; i++) {
      let selectedPageStyle = this._getSelectedPageStyle(aContent.frames[i]);
      if (selectedPageStyle)
        return selectedPageStyle;
    }
    return "";
  },

  /**
   * collect the state of all form elements
   * @param aDocument
   *        document reference
   */
  _collectFormDataForFrame: function sss_collectFormDataForFrame(aDocument) {
    let formNodes = aDocument.evaluate(XPathHelper.restorableFormNodes, aDocument,
                                       XPathHelper.resolveNS,
                                       Components.interfaces.nsIDOMXPathResult.UNORDERED_NODE_ITERATOR_TYPE, null);
    let node = formNodes.iterateNext();
    if (!node)
      return null;

    const MAX_GENERATED_XPATHS = 100;
    let generatedCount = 0;

    let data = {};
    do {
      let nId = node.id;
      let hasDefaultValue = true;
      let value;

      // Only generate a limited number of XPath expressions for perf reasons (cf. bug 477564)
      if (!nId && generatedCount > MAX_GENERATED_XPATHS)
        continue;

      if (node instanceof Components.interfaces.nsIDOMHTMLInputElement ||
          node instanceof Components.interfaces.nsIDOMHTMLTextAreaElement) {
        switch (node.type) {
          case "checkbox":
          case "radio":
            value = node.checked;
            hasDefaultValue = value == node.defaultChecked;
            break;
          case "file":
            value = { type: "file", fileList: node.mozGetFileNameArray() };
            hasDefaultValue = !value.fileList.length;
            break;
          default: // text, textarea
            value = node.value;
            hasDefaultValue = value == node.defaultValue;
            break;
        }
      }
      else if (!node.multiple) {
        // <select>s without the multiple attribute are hard to determine the
        // default value, so assume we don't have the default.
        hasDefaultValue = false;
        value = node.selectedIndex;
      }
      else {
        // <select>s with the multiple attribute are easier to determine the
        // default value since each <option> has a defaultSelected
        let options = Array.map(node.options, function(aOpt, aIx) {
          let oSelected = aOpt.selected;
          hasDefaultValue = hasDefaultValue && (oSelected == aOpt.defaultSelected);
          return oSelected ? aIx : -1;
        });
        value = options.filter(function(aIx) aIx >= 0);
      }
      // In order to reduce XPath generation (which is slow), we only save data
      // for form fields that have been changed. (cf. bug 537289)
      if (!hasDefaultValue) {
        if (nId) {
          data["#" + nId] = value;
        }
        else {
          generatedCount++;
          data[XPathHelper.generate(node)] = value;
        }
      }

    } while ((node = formNodes.iterateNext()));

    return data;
  },

  /**
   * store all hosts for a URL
   * @param aWindow
   *        Window reference
   */
  _updateCookieHosts: function sss_updateCookieHosts(aWindow) {
    var hosts = this._windows[aWindow.__SSi]._hosts = {};

    // get the host for each URL
    var _this = this;
    function extractHosts(aEntry) {
      var match = /^https?:\/\/(?:[^@\/\s]+@)?([\w.-]+)/.exec(aEntry.url);
      if (match) {
        if (!hosts[match[1]] && _this._checkPrivacyLevel(_this._getURIFromString(aEntry.url).schemeIs("https"))) {
          hosts[match[1]] = true;
        }
      }
      else if ((match = /^file:\/\/([^\/]*)/.exec(aEntry.url)) != null) {
        hosts[match[1]] = true;
      }
      if (aEntry.children) {
        aEntry.children.forEach(extractHosts);
      }
    }

    this._windows[aWindow.__SSi].tabs.forEach(function(aTabData) { aTabData.entries.forEach(extractHosts); });
  },

  /**
   * Serialize cookie data
   * @param aWindows
   *        array of Window references
   */
  _updateCookies: function sss_updateCookies(aWindows) {
    // collect the cookies per window
    for (var i = 0; i < aWindows.length; i++)
      aWindows[i].cookies = [];

    var jscookies = {};
    var _this = this;
    // MAX_EXPIRY should be 2^63-1, but JavaScript can't handle that precision
    var MAX_EXPIRY = Math.pow(2, 62);
    aWindows.forEach(function(aWindow) {
      for (var host in aWindow._hosts) {
        var list = cm.getCookiesFromHost(host);
        while (list.hasMoreElements()) {
          var cookie = list.getNext().QueryInterface(Components.interfaces.nsICookie2);
          if (cookie.isSession && _this._checkPrivacyLevel(cookie.isSecure)) {
            // use the cookie's host, path, and name as keys into a hash,
            // to make sure we serialize each cookie only once

            // lazily build up a 3-dimensional hash, with
            // host, path, and name as keys
            if (!jscookies[cookie.host])
              jscookies[cookie.host] = {};
            if (!jscookies[cookie.host][cookie.path])
              jscookies[cookie.host][cookie.path] = {};

            if (!jscookies[cookie.host][cookie.path][cookie.name]) {
              var jscookie = { "host": cookie.host, "value": cookie.value };
              // only add attributes with non-default values (saving a few bits)
              if (cookie.path) jscookie.path = cookie.path;
              if (cookie.name) jscookie.name = cookie.name;
              if (cookie.isSecure) jscookie.secure = true;
              if (cookie.isHttpOnly) jscookie.httponly = true;
              if (cookie.expiry < MAX_EXPIRY) jscookie.expiry = cookie.expiry;
  
              jscookies[cookie.host][cookie.path][cookie.name] = jscookie;
            }
            aWindow.cookies.push(jscookies[cookie.host][cookie.path][cookie.name]);
          }
        }
      }
    });

    // don't include empty cookie sections
    for (i = 0; i < aWindows.length; i++)
      if (aWindows[i].cookies.length == 0)
        delete aWindows[i].cookies;
  },

  /**
   * Store window dimensions, visibility, sidebar
   * @param aWindow
   *        Window reference
   */
  _updateWindowFeatures: function sss_updateWindowFeatures(aWindow) {
    var winData = this._windows[aWindow.__SSi];

    for (var aAttr in WINDOW_ATTRIBUTES)
      winData[aAttr] = this._getWindowDimension(aWindow, aAttr);

    var hidden = WINDOW_HIDEABLE_FEATURES.filter(function(aItem) {
      return aWindow[aItem] && !aWindow[aItem].visible;
    });
    if (hidden.length != 0)
      winData.hidden = hidden.join(",");
    else if (winData.hidden)
      delete winData.hidden;

    var sidebar = aWindow.document.getElementById("sidebar-box").getAttribute("sidebarcommand");
    if (sidebar)
      winData.sidebar = sidebar;
    else if (winData.sidebar)
      delete winData.sidebar;
  },

  /**
   * serialize session data as Ini-formatted string
   * @param aUpdateAll
   *        Bool update all windows
   * @returns string
   */
  _getCurrentState: function sss_getCurrentState(aUpdateAll) {
    this._handleClosedWindows();

    var activeWindow = this._getMostRecentBrowserWindow();

    if (this._loadState == STATE_RUNNING) {
      // update the data for all windows with activities since the last save operation
      this._forEachBrowserWindow(function(aWindow) {
        if (!this._isWindowLoaded(aWindow)) // window data is still in _statesToRestore
          return;
        if (aUpdateAll || this._dirtyWindows[aWindow.__SSi] || aWindow == activeWindow) {
          this._collectWindowData(aWindow);
        }
        else { // always update the window features (whose change alone never triggers a save operation)
          this._updateWindowFeatures(aWindow);
        }
      });
      this._dirtyWindows = [];
    }

    // collect the data for all windows
    var total = [], windows = [];
    var nonPopupCount = 0;
    var ix;
    for (ix in this._windows) {
      if (this._windows[ix].__SS_restoreID in this._statesToRestore) // window data is still in _statesToRestore
        continue;
      total.push(this._windows[ix]);
      windows.push(ix);
      if (!this._windows[ix].isPopup)
        nonPopupCount++;
    }
    this._updateCookies(total);

    // collect the data for all windows yet to be restored
    for (ix in this._statesToRestore) {
      for each (let winData in this._statesToRestore[ix].windows) {
        total.push(winData);
        if (!winData.isPopup)
          nonPopupCount++;
      }
    }

    // shallow copy this._closedWindows to preserve current state
    let lastClosedWindowsCopy = this._closedWindows.slice();

#ifndef XP_MACOSX
    // if no non-popup browser window remains open, return the state of the last closed window(s)
    if (nonPopupCount == 0 && lastClosedWindowsCopy.length > 0) {
      // prepend the last non-popup browser window, so that if the user loads more tabs
      // at startup we don't accidentally add them to a popup window
      do {
        total.unshift(lastClosedWindowsCopy.shift())
      } while (total[0].isPopup)
    }
#endif

    if (activeWindow) {
      this.activeWindowSSiCache = activeWindow.__SSi || "";
    }
    ix = windows.indexOf(this.activeWindowSSiCache);
    // We don't want to restore focus to a minimized window.
    if (ix != -1 && total[ix].sizemode == "minimized")
      ix = -1;

    return { windows: total, selectedWindow: ix + 1, _closedWindows: lastClosedWindowsCopy };
  },

  /**
   * serialize session data for a window
   * @param aWindow
   *        Window reference
   * @returns string
   */
  _getWindowState: function sss_getWindowState(aWindow) {
    if (!this._isWindowLoaded(aWindow))
      return this._statesToRestore[aWindow.__SS_restoreID];

    if (this._loadState == STATE_RUNNING) {
      this._collectWindowData(aWindow);
    }

    var total = [this._windows[aWindow.__SSi]];
    this._updateCookies(total);

    return { windows: total };
  },

  _collectWindowData: function sss_collectWindowData(aWindow) {
    if (!this._isWindowLoaded(aWindow))
      return;

    // update the internal state data for this window
    this._saveWindowHistory(aWindow);
    this._updateTextAndScrollData(aWindow);
    this._updateCookieHosts(aWindow);
    this._updateWindowFeatures(aWindow);

    this._dirtyWindows[aWindow.__SSi] = false;
  },

/* ........ Restoring Functionality .............. */

  /**
   * restore features to a single window
   * @param aWindow
   *        Window reference
   * @param aState
   *        JS object or its eval'able source
   * @param aOverwriteTabs
   *        bool overwrite existing tabs w/ new ones
   * @param aFollowUp
   *        bool this isn't the restoration of the first window
   */
  restoreWindow: function sss_restoreWindow(aWindow, aState, aOverwriteTabs, aFollowUp) {
    if (!aFollowUp) {
      this.windowToFocus = aWindow;
    }
    // initialize window if necessary
    if (aWindow && (!aWindow.__SSi || !this._windows[aWindow.__SSi]))
      this.onLoad(aWindow);

    try {
      var root = typeof aState == "string" ? JSON.parse(aState) : aState;
      if (!root.windows[0]) {
        this._sendRestoreCompletedNotifications();
        return; // nothing to restore
      }
    }
    catch (ex) { // invalid state object - don't restore anything
      debug(ex);
      this._sendRestoreCompletedNotifications();
      return;
    }

    if (root._closedWindows)
      this._closedWindows = root._closedWindows;

    var winData;
    if (!aState.selectedWindow) {
      aState.selectedWindow = 0;
    }
    // open new windows for all further window entries of a multi-window session
    // (unless they don't contain any tab data)
    for (var w = 1; w < root.windows.length; w++) {
      winData = root.windows[w];
      if (winData && winData.tabs && winData.tabs[0]) {
        var window = this._openWindowWithState({ windows: [winData] });
        if (w == aState.selectedWindow - 1) {
          this.windowToFocus = window;
        }
      }
    }
    winData = root.windows[0];
    if (!winData.tabs) {
      winData.tabs = [];
    }
    // don't restore a single blank tab when we've had an external
    // URL passed in for loading at startup (cf. bug 357419)
    else if (root._firstTabs && !aOverwriteTabs && winData.tabs.length == 1 &&
             (!winData.tabs[0].entries || winData.tabs[0].entries.length == 0)) {
      winData.tabs = [];
    }

    var tabbrowser = aWindow.getBrowser();
    var openTabCount = aOverwriteTabs ? tabbrowser.browsers.length : -1;
    var newTabCount = winData.tabs.length;
    let tabs = [];

    for (var t = 0; t < newTabCount; t++) {
      tabs.push(t < openTabCount ? tabbrowser.tabs[t] : tabbrowser.addTab());
      // when resuming at startup: add additionally requested pages to the end
      if (!aOverwriteTabs && root._firstTabs) {
        tabbrowser.moveTabTo(tabs[t], t);
      }
    }

    // when overwriting tabs, remove all superflous ones
    for (t = openTabCount - 1; t >= newTabCount; t--) {
      tabbrowser.removeTab(tabbrowser.tabs[t]);
    }

    if (aOverwriteTabs) {
      this.restoreWindowFeatures(aWindow, winData);
      delete this._windows[aWindow.__SSi].extData;
    }
    if (winData.cookies) {
      this.restoreCookies(winData.cookies);
    }
    if (winData.extData) {
      if (!this._windows[aWindow.__SSi].extData) {
        this._windows[aWindow.__SSi].extData = {};
      }
      for (var key in winData.extData) {
        this._windows[aWindow.__SSi].extData[key] = winData.extData[key];
      }
    }
    if (aOverwriteTabs || root._firstTabs) {
      this._windows[aWindow.__SSi]._closedTabs = winData._closedTabs || [];
    }

    this.restoreHistoryPrecursor(aWindow, tabs, winData.tabs,
      (aOverwriteTabs ? (parseInt(winData.selected) || 1) : 0), 0, 0);

    this._sendRestoreCompletedNotifications();
  },

  /**
   * Manage history restoration for a window
   * @param aWindow
   *        Window to restore the tabs into
   * @param aTabs
   *        Array of tab references
   * @param aTabData
   *        Array of tab data
   * @param aSelectTab
   *        Index of selected tab
   * @param aIx
   *        Index of the next tab to check readyness for
   * @param aCount
   *        Counter for number of times delaying b/c browser or history aren't ready
   */
  restoreHistoryPrecursor:
    function sss_restoreHistoryPrecursor(aWindow, aTabs, aTabData, aSelectTab, aIx, aCount) {
    var tabbrowser = aWindow.getBrowser();

    // make sure that all browsers and their histories are available
    // - if one's not, resume this check in 100ms (repeat at most 10 times)
    for (var t = aIx; t < aTabs.length; t++) {
      try {
        if (!tabbrowser.getBrowserForTab(aTabs[t]).webNavigation.sessionHistory) {
          throw new Error();
        }
      }
      catch (ex) { // in case browser or history aren't ready yet
        if (aCount < 10) {
          var restoreHistoryFunc = function(self) {
            self.restoreHistoryPrecursor(aWindow, aTabs, aTabData, aSelectTab, aIx, aCount + 1);
          }
          aWindow.setTimeout(restoreHistoryFunc, 100, this);
          return;
        }
      }
    }

    // mark the tabs as loading
    for (t = 0; t < aTabs.length; t++) {
      var tab = aTabs[t];
      var browser = tabbrowser.getBrowserForTab(tab);

      aTabData[t]._tabStillLoading = true;
      if (!aTabData[t].entries || aTabData[t].entries.length == 0) {
        // make sure to blank out this tab's content
        // (just purging the tab's history won't be enough)
        browser.contentDocument.location = "about:blank";
        continue;
      }

      browser.stop(); // in case about:blank isn't done yet

      tab.setAttribute("busy", "true");
      tab.removeAttribute("image");

      // wall-paper fix for bug 439675: make sure that the URL to be loaded
      // is always visible in the address bar
      let activeIndex = (aTabData[t].index || aTabData[t].entries.length) - 1;
      let activePageData = aTabData[t].entries[activeIndex] || null;
      browser.userTypedValue = activePageData ? activePageData.url || null : null;

      // keep the data around to prevent dataloss in case
      // a tab gets closed before it's been properly restored
      browser.__SS_data = aTabData[t];
    }

    // make sure to restore the selected tab first (if any)
    if (aSelectTab-- && aTabs[aSelectTab]) {
        aTabs.unshift(aTabs.splice(aSelectTab, 1)[0]);
        aTabData.unshift(aTabData.splice(aSelectTab, 1)[0]);
        tabbrowser.selectedTab = aTabs[0];
    }

    if (!this._isWindowLoaded(aWindow)) {
      // from now on, the data will come from the actual window
      delete this._statesToRestore[aWindow.__SS_restoreID];
      delete aWindow.__SS_restoreID;
    }

    // helper hashes for ensuring unique frame IDs and unique document
    // identifiers.
    var idMap = { used: {} };
    var docIdentMap = {};
    this.restoreHistory(aWindow, aTabs, aTabData, idMap, docIdentMap);
  },

  /**
   * Restore history for a window
   * @param aWindow
   *        Window reference
   * @param aTabs
   *        Array of tab references
   * @param aTabData
   *        Array of tab data
   * @param aIdMap
   *        Hash for ensuring unique frame IDs
   */
  restoreHistory:
    function sss_restoreHistory(aWindow, aTabs, aTabData, aIdMap, aDocIdentMap) {
    var _this = this;
    while (aTabs.length > 0 && (!aTabData[0]._tabStillLoading || !aTabs[0].parentNode)) {
      aTabs.shift(); // this tab got removed before being completely restored
      aTabData.shift();
    }
    if (aTabs.length == 0) {
      return; // no more tabs to restore
    }

    var tab = aTabs.shift();
    var tabData = aTabData.shift();

    var browser = aWindow.getBrowser().getBrowserForTab(tab);
    var history = browser.webNavigation.sessionHistory;

    if (history.count > 0) {
      history.PurgeHistory(history.count);
    }
    history.QueryInterface(Components.interfaces.nsISHistoryInternal);

    if (!tabData.entries) {
      tabData.entries = [];
    }
    if (tabData.extData) {
      tab.__SS_extdata = {};
      for (let key in tabData.extData)
        tab.__SS_extdata[key] = tabData.extData[key];
    }
    else
      delete tab.__SS_extdata;

    for (var i = 0; i < tabData.entries.length; i++) {
      //XXXzpao Wallpaper patch for bug 509315
      if (!tabData.entries[i].url)
        continue;
      history.addEntry(this._deserializeHistoryEntry(tabData.entries[i],
                                                     aIdMap, aDocIdentMap), true);
    }

    // make sure to reset the capabilities and attributes, in case this tab gets reused
    var disallow = (tabData.disallow)?tabData.disallow.split(","):[];
    CAPABILITIES.forEach(function(aCapability) {
      browser.docShell["allow" + aCapability] = disallow.indexOf(aCapability) == -1;
    });
    Array.filter(tab.attributes, function(aAttr) {
      return (_this.xulAttributes.indexOf(aAttr.name) > -1);
    }).forEach(tab.removeAttribute, tab);
    for (let name in tabData.attributes)
      tab.setAttribute(name, tabData.attributes[name]);

    if (tabData.storage && browser.docShell instanceof Components.interfaces.nsIDocShell)
      this._deserializeSessionStorage(tabData.storage, browser.docShell);

    // notify the tabbrowser that the tab chrome has been restored
    var event = aWindow.document.createEvent("Events");
    event.initEvent("SSTabRestoring", true, false);
    tab.dispatchEvent(event);

    let activeIndex = (tabData.index || tabData.entries.length) - 1;
    if (activeIndex >= tabData.entries.length)
      activeIndex = tabData.entries.length - 1;
    try {
      if (activeIndex >= 0)
        browser.webNavigation.gotoIndex(activeIndex);
    }
    catch (ex) {
      // ignore page load errors
      tab.removeAttribute("busy");
    }

    if (tabData.entries.length > 0) {
      // restore those aspects of the currently active documents
      // which are not preserved in the plain history entries
      // (mainly scroll state and text data)
      browser.__SS_restore_data = tabData.entries[activeIndex] || {};
      browser.__SS_restore_pageStyle = tabData.pageStyle || "";
      browser.__SS_restore_tab = tab;
    }

    // Handle userTypedValue. Setting userTypedValue seems to update gURLbar
    // as needed. Calling loadURI will cancel form filling in restoreDocument_proxy
    if (tabData.userTypedValue) {
      browser.userTypedValue = tabData.userTypedValue;
      if (tabData.userTypedClear)
        browser.loadURI(tabData.userTypedValue, null, null, true);
    }

    aWindow.setTimeout(function() {
      _this.restoreHistory(aWindow, aTabs, aTabData, aIdMap, aDocIdentMap);
    }, 0);
  },

  /**
   * expands serialized history data into a session-history-entry instance
   * @param aEntry
   *        Object containing serialized history data for a URL
   * @param aIdMap
   *        Hash for ensuring unique frame IDs
   * @returns nsISHEntry
   */
  _deserializeHistoryEntry:
    function sss_deserializeHistoryEntry(aEntry, aIdMap, aDocIdentMap) {

    var shEntry = Components.classes["@mozilla.org/browser/session-history-entry;1"]
                            .createInstance(Components.interfaces.nsISHEntry);

    shEntry.setURI(Services.io.newURI(aEntry.url, null, null));
    shEntry.setTitle(aEntry.title || aEntry.url);
    if (aEntry.subframe)
      shEntry.setIsSubFrame(aEntry.subframe || false);
    shEntry.loadType = Components.interfaces.nsIDocShellLoadInfo.loadHistory;
    if (aEntry.contentType)
      shEntry.contentType = aEntry.contentType;
    if (aEntry.referrer)
      shEntry.referrerURI = Services.io.newURI(aEntry.referrer, null, null);

    if (aEntry.cacheKey) {
      var cacheKey = Components.classes["@mozilla.org/supports-PRUint32;1"]
                               .createInstance(Components.interfaces.nsISupportsPRUint32);
      cacheKey.data = aEntry.cacheKey;
      shEntry.cacheKey = cacheKey;
    }

    if (aEntry.ID) {
      // get a new unique ID for this frame (since the one from the last
      // start might already be in use)
      var id = aIdMap[aEntry.ID] || 0;
      if (!id) {
        for (id = Date.now(); id in aIdMap.used; id++);
        aIdMap[aEntry.ID] = id;
        aIdMap.used[id] = true;
      }
      shEntry.ID = id;
    }

    if (aEntry.stateData) {
      shEntry.stateData = aEntry.stateData;
    }

    if (aEntry.scroll) {
      var scrollPos = (aEntry.scroll || "0,0").split(",");
      scrollPos = [parseInt(scrollPos[0]) || 0, parseInt(scrollPos[1]) || 0];
      shEntry.setScrollPosition(scrollPos[0], scrollPos[1]);
    }

    if (aEntry.postdata_b64) {
      var postdata = atob(aEntry.postdata_b64);
      var stream = Components.classes["@mozilla.org/io/string-input-stream;1"]
                             .createInstance(Components.interfaces.nsIStringInputStream);
      stream.setData(postdata, postdata.length);
      shEntry.postData = stream;
    }

    if (aEntry.docIdentifier) {
      // Get a new document identifier for this entry to ensure that history
      // entries after a session restore are considered to have different
      // documents from the history entries before the session restore.
      // Document identifiers are 64-bit ints, so JS will loose precision and
      // start assigning all entries the same doc identifier if these ever get
      // large enough.
      //
      // It's a potential security issue if document identifiers aren't
      // globally unique, but shEntry.setUniqueDocIdentifier() below guarantees
      // that we won't re-use a doc identifier within a given instance of the
      // application.
      if (!aDocIdentMap[aEntry.docIdentifier]) {
        shEntry.setUniqueDocIdentifier();
        aDocIdentMap[aEntry.docIdentifier] = shEntry.docIdentifier;
      }
      else {
        shEntry.docIdentifier = aDocIdentMap[aEntry.docIdentifier];
      }
    }

    if (aEntry.owner_b64) {
      var ownerInput = Components.classes["@mozilla.org/io/string-input-stream;1"]
                                 .createInstance(Components.interfaces.nsIStringInputStream);
      var binaryData = atob(aEntry.owner_b64);
      ownerInput.setData(binaryData, binaryData.length);
      var binaryStream = Components.classes["@mozilla.org/binaryinputstream;1"]
                                   .createInstance(Components.interfaces.nsIObjectInputStream);
      binaryStream.setInputStream(ownerInput);
      try { // Catch possible deserialization exceptions
        shEntry.owner = binaryStream.readObject(true);
      } catch (ex) { debug(ex); }
    }

    if (aEntry.children && shEntry instanceof Components.interfaces.nsISHContainer) {
      for (var i = 0; i < aEntry.children.length; i++) {
        //XXXzpao Wallpaper patch for bug 509315
        if (!aEntry.children[i].url)
          continue;
        shEntry.AddChild(this._deserializeHistoryEntry(aEntry.children[i], aIdMap,
                                                       aDocIdentMap), i);
      }
    }

    return shEntry;
  },

  /**
   * restores all sessionStorage "super cookies"
   * @param aStorageData
   *        Storage data to be restored
   * @param aDocShell
   *        A tab's docshell (containing the sessionStorage)
   */
  _deserializeSessionStorage: function sss_deserializeSessionStorage(aStorageData, aDocShell) {
    for (let url in aStorageData) {
      let uri = Services.io.newURI(url, null, null);
      let storage = aDocShell.getSessionStorageForURI(uri, "");
      for (let key in aStorageData[url]) {
        try {
          storage.setItem(key, aStorageData[url][key]);
        }
        catch (ex) { Components.utils.reportError(ex); } // throws e.g. for URIs that can't have sessionStorage
      }
    }
  },

  /**
   * Restore properties to a loaded document
   */
  restoreDocument: function sss_restoreDocument(aWindow, aBrowser, aEvent) {
    // wait for the top frame to be loaded completely
    if (!aEvent || !aEvent.originalTarget || !aEvent.originalTarget.defaultView || aEvent.originalTarget.defaultView != aEvent.originalTarget.defaultView.top) {
      return;
    }

    // always call this before injecting content into a document!
    function hasExpectedURL(aDocument, aURL)
      !aURL || aURL.replace(/#.*/, "") == aDocument.location.href.replace(/#.*/, "");

    function restoreFormData(aDocument, aData, aURL) {
      for (let key in aData) {
        if (!hasExpectedURL(aDocument, aURL))
          return;

        let node = key.charAt(0) == "#" ? aDocument.getElementById(key.slice(1)) :
                                          XPathHelper.resolve(aDocument, key);
        if (!node)
          continue;

        let value = aData[key];
        if (typeof value == "string" && node.type != "file") {
          if (node.value == value)
            continue; // don't dispatch an input event for no change

          node.value = value;

          let event = aDocument.createEvent("UIEvents");
          event.initUIEvent("input", true, true, aDocument.defaultView, 0);
          node.dispatchEvent(event);
        }
        else if (typeof value == "boolean")
          node.checked = value;
        else if (typeof value == "number")
          try {
            node.selectedIndex = value;
          } catch (ex) { /* throws for invalid indices */ }
        else if (value && value.fileList && value.type == "file" && node.type == "file")
          node.mozSetFileNameArray(value.fileList, value.fileList.length);
        else if (value && typeof value.indexOf == "function" && node.options) {
          Array.forEach(node.options, function(aOpt, aIx) {
            aOpt.selected = value.indexOf(aIx) > -1;
          });
        }
        // NB: dispatching "change" events might have unintended side-effects
      }
    }

    let selectedPageStyle = aBrowser.__SS_restore_pageStyle;
    function restoreTextDataAndScrolling(aContent, aData, aPrefix) {
      if (aData.formdata)
        restoreFormData(aContent.document, aData.formdata, aData.url);
      if (aData.innerHTML) {
        aWindow.setTimeout(function() {
          if (aContent.document.designMode == "on" &&
              hasExpectedURL(aContent.document, aData.url)) {
            aContent.document.body.innerHTML = aData.innerHTML;
          }
        }, 0);
      }
      var match;
      if (aData.scroll && (match = /(\d+),(\d+)/.exec(aData.scroll)) != null) {
        aContent.scrollTo(match[1], match[2]);
      }
      Array.forEach(aContent.document.styleSheets, function(aSS) {
        aSS.disabled = aSS.title && aSS.title != selectedPageStyle;
      });
      for (var i = 0; i < aContent.frames.length; i++) {
        if (aData.children && aData.children[i] &&
          hasExpectedURL(aContent.document, aData.url)) {
          restoreTextDataAndScrolling(aContent.frames[i], aData.children[i], aPrefix + i + "|");
        }
      }
    }

    // don't restore text data and scrolling state if the user has navigated
    // away before the loading completed (except for in-page navigation)
    if (hasExpectedURL(aEvent.originalTarget, aBrowser.__SS_restore_data.url)) {
      var content = aEvent.originalTarget.defaultView;
      if (aBrowser.currentURI.spec == "about:config") {
        // unwrap the document for about:config because otherwise the properties
        // of the XBL bindings - as the textbox - aren't accessible (see bug 350718)
        content = content.wrappedJSObject;
      }
      restoreTextDataAndScrolling(content, aBrowser.__SS_restore_data, "");
      aBrowser.markupDocumentViewer.authorStyleDisabled = selectedPageStyle == "_nostyle";

      // notify the tabbrowser that this document has been completely restored
      var event = aBrowser.ownerDocument.createEvent("Events");
      event.initEvent("SSTabRestored", true, false);
      aBrowser.__SS_restore_tab.dispatchEvent(event);
    }

    delete aBrowser.__SS_restore_data;
    delete aBrowser.__SS_restore_pageStyle;
    delete aBrowser.__SS_restore_tab;
  },

  /**
   * Restore visibility and dimension features to a window
   * @param aWindow
   *        Window reference
   * @param aWinData
   *        Object containing session data for the window
   */
  restoreWindowFeatures: function sss_restoreWindowFeatures(aWindow, aWinData) {
    var hidden = (aWinData.hidden)?aWinData.hidden.split(","):[];
    WINDOW_HIDEABLE_FEATURES.forEach(function(aItem) {
      aWindow[aItem].visible = hidden.indexOf(aItem) == -1;
    });

    if (aWinData.isPopup)
      this._windows[aWindow.__SSi].isPopup = true;
    else
      delete this._windows[aWindow.__SSi].isPopup;

    var _this = this;
    aWindow.setTimeout(function() {
      _this.restoreDimensions.apply(_this, [aWindow, aWinData.width || 0,
        aWinData.height || 0, "screenX" in aWinData ? aWinData.screenX : NaN,
        "screenY" in aWinData ? aWinData.screenY : NaN,
        aWinData.sizemode || "", aWinData.sidebar || ""]);
    }, 0);
  },

  /**
   * Restore a window's dimensions
   * @param aWidth
   *        Window width
   * @param aHeight
   *        Window height
   * @param aLeft
   *        Window left
   * @param aTop
   *        Window top
   * @param aSizeMode
   *        Window size mode (eg: maximized)
   * @param aSidebar
   *        Sidebar command
   */
  restoreDimensions: function sss_restoreDimensions(aWindow, aWidth, aHeight, aLeft, aTop, aSizeMode, aSidebar) {
    var win = aWindow;
    var _this = this;
    function win_(aName) { return _this._getWindowDimension(win, aName); }

    // only modify those aspects which aren't correct yet
    if (aWidth && aHeight && (aWidth != win_("width") || aHeight != win_("height"))) {
      aWindow.resizeTo(aWidth, aHeight);
    }
    if (!isNaN(aLeft) && !isNaN(aTop) && (aLeft != win_("screenX") || aTop != win_("screenY"))) {
      aWindow.moveTo(aLeft, aTop);
    }
    if (aSizeMode && win_("sizemode") != aSizeMode)
    {
      switch (aSizeMode)
      {
      case "maximized":
        aWindow.maximize();
        break;
      case "minimized":
        aWindow.minimize();
        break;
      case "normal":
        aWindow.restore();
        break;
      }
    }
    var sidebar = aWindow.document.getElementById("sidebar-box");
    if (sidebar.getAttribute("sidebarcommand") != aSidebar) {
      aWindow.toggleSidebar(aSidebar);
    }
    // since resizing/moving a window brings it to the foreground,
    // we might want to re-focus the last focused window
    if (this.windowToFocus && this.windowToFocus.content) {
      this.windowToFocus.content.focus();
    }
  },

  /**
   * Restores cookies
   * @param aCookies
   *        Array of cookie objects
   */
  restoreCookies: function sss_restoreCookies(aCookies) {
    // MAX_EXPIRY should be 2^63-1, but JavaScript can't handle that precision
    var MAX_EXPIRY = Math.pow(2, 62);
    for (let i = 0; i < aCookies.length; i++) {
      var cookie = aCookies[i];
      try {
        cm.add(cookie.host, cookie.path || "", cookie.name || "",
                      cookie.value, !!cookie.secure, !!cookie.httponly, true,
                      "expiry" in cookie ? cookie.expiry : MAX_EXPIRY);
      }
      catch (ex) { Components.utils.reportError(ex); } // don't let a single cookie stop recovering
    }
  },

/* ........ Disk Access .............. */

  /**
   * save state delayed by N ms
   * marks window as dirty (i.e. data update can't be skipped)
   * @param aWindow
   *        Window reference
   * @param aDelay
   *        Milliseconds to delay
   */
  saveStateDelayed: function sss_saveStateDelayed(aWindow, aDelay) {
    if (aWindow) {
      this._dirtyWindows[aWindow.__SSi] = true;
    }

    if (!this._saveTimer && this._resume_from_crash) {
      // interval until the next disk operation is allowed
      var minimalDelay = this._lastSaveTime + this._interval - Date.now();

      // if we have to wait, set a timer, otherwise saveState directly
      aDelay = Math.max(minimalDelay, aDelay || 2000);
      if (aDelay > 0) {
        this._saveTimer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
        this._saveTimer.init(this, aDelay, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
      }
      else {
        this.saveState();
      }
    }
  },

  /**
   * save state to disk
   * @param aUpdateAll
   *        Bool update all windows
   */
  saveState: function sss_saveState(aUpdateAll) {
    // if crash recovery is disabled, only save session resuming information
    if (!this._resume_from_crash && this._loadState == STATE_RUNNING)
      return;

    var oState = this._getCurrentState(aUpdateAll);
    oState.session = {
      state: this._loadState == STATE_RUNNING ? STATE_RUNNING_STR : STATE_STOPPED_STR,
      lastUpdate: Date.now()
    };
    if (this._recentCrashes)
      oState.session.recentCrashes = this._recentCrashes;

    this._saveStateObject(oState);
  },

  /**
   * write a state object to disk
   */
  _saveStateObject: function sss_saveStateObject(aStateObj) {
    var stateString = Components.classes["@mozilla.org/supports-string;1"]
                                .createInstance(Components.interfaces.nsISupportsString);
    // parentheses are for backwards compatibility with older sessionstore files
    stateString.data = this._toJSONString(aStateObj);

    Services.obs.notifyObservers(stateString, "sessionstore-state-write", "");

    // don't touch the file if an observer has deleted all state data
    if (stateString.data)
      this._writeFile(this._sessionFile, stateString.data);

    this._lastSaveTime = Date.now();
  },

  /**
   * delete session datafile and backup
   */
  _clearDisk: function sss_clearDisk() {
    if (this._sessionFile.exists()) {
      try {
        this._sessionFile.remove(false);
      }
      catch (ex) { dump(ex + '\n'); } // couldn't remove the file - what now?
    }
    if (this._sessionFileBackup.exists()) {
      try {
        this._sessionFileBackup.remove(false);
      }
      catch (ex) { dump(ex + '\n'); } // couldn't remove the file - what now?
    }
  },

/* ........ Auxiliary Functions .............. */

  /**
   * call a callback for all currently opened browser windows
   * (might miss the most recent one)
   * @param aFunc
   *        Callback each window is passed to
   */
  _forEachBrowserWindow: function sss_forEachBrowserWindow(aFunc) {
    var windowsEnum = Services.wm.getEnumerator("navigator:browser");

    while (windowsEnum.hasMoreElements()) {
      var window = windowsEnum.getNext();
      if (!window.closed && window.__SSi) {
        aFunc.call(this, window);
      }
    }
  },

  /**
   * Returns most recent window
   * @returns Window reference
   */
  _getMostRecentBrowserWindow: function sss_getMostRecentBrowserWindow() {
    var win = Services.wm.getMostRecentWindow("navigator:browser");
    if (win && !win.closed)
      return win;

#ifdef BROKEN_WM_Z_ORDER
    win = null;
    var windowsEnum = Services.wm.getEnumerator("navigator:browser");
    // this is oldest to newest, so this gets a bit ugly
    while (windowsEnum.hasMoreElements()) {
      let nextWin = windowsEnum.getNext();
      if (!nextWin.closed)
        win = nextWin;
    }
    return win;
#else
    var windowsEnum =
      Services.wm.getZOrderDOMWindowEnumerator("navigator:browser", true);
    while (windowsEnum.hasMoreElements()) {
      win = windowsEnum.getNext();
      if (!win.closed)
        return win;
    }
    return null;
#endif
  },

  /**
   * Calls onClose for windows that are determined to be closed but aren't
   * destroyed yet, which would otherwise cause getBrowserState and
   * setBrowserState to treat them as open windows.
   */
  _handleClosedWindows: function sss_handleClosedWindows() {
    var windowsEnum = Services.wm.getEnumerator("navigator:browser");

    while (windowsEnum.hasMoreElements()) {
      var window = windowsEnum.getNext();
      if (window.closed) {
        this.onClose(window);
      }
    }
  },

  /**
   * open a new browser window for a given session state
   * called when restoring a multi-window session
   * @param aState
   *        Object containing session data
   */
  _openWindowWithState: function sss_openWindowWithState(aState) {
    var argString = Components.classes["@mozilla.org/supports-string;1"]
                              .createInstance(Components.interfaces.nsISupportsString);
    argString.data = "about:blank";

    var features = "chrome,dialog=no,all";
    var winState = aState.windows[0];
    for (var aAttr in WINDOW_ATTRIBUTES) {
      // Use !isNaN as an easy way to ignore sizemode and check for numbers
      if (aAttr in winState && !isNaN(winState[aAttr]))
        features += "," + WINDOW_ATTRIBUTES[aAttr] + "=" + winState[aAttr];
    }

    var window =
      Services.ww.openWindow(null, this._prefBranch.getCharPref("chromeURL"),
                             "_blank", features, argString);

    do {
      var ID = "window" + Math.random();
    } while (ID in this._statesToRestore);
    this._statesToRestore[(window.__SS_restoreID = ID)] = aState;

    return window;
  },

  /**
   * Whether or not to resume session, if not recovering from a crash.
   * @returns bool
   */
  _doResumeSession: function sss_doResumeSession() {
    return this._prefBranch.getIntPref("startup.page") == 3 ||
      this._prefBranch.getBoolPref("sessionstore.resume_session_once");
  },

  /**
   * Are we restarting to switch profile.
   * @returns bool
   */
  _isSwitchingProfile: function sss_isSwitchingProfile() {
    var env = Components.classes["@mozilla.org/process/environment;1"]
                        .getService(Components.interfaces.nsIEnvironment);
    return env.exists("XRE_PROFILE_NAME");
  },

  /**
   * whether the user wants to load any other page at startup
   * (except the homepage) - needed for determining whether to overwrite the current tabs
   * C.f.: nsBrowserContentHandler's defaultArgs implementation.
   * @returns bool
   */
  _isCmdLineEmpty: function sss_isCmdLineEmpty(aWindow) {
    return "arguments" in aWindow && aWindow.arguments.length &&
      aWindow.arguments[0] == "about:blank";
  },

  /**
   * don't save sensitive data if the user doesn't want to
   * (distinguishes between encrypted and non-encrypted sites)
   * @param aIsHTTPS
   *        Bool is encrypted
   * @returns bool
   */
  _checkPrivacyLevel: function sss_checkPrivacyLevel(aIsHTTPS) {
    return this._prefBranch.getIntPref("sessionstore.privacy_level") < (aIsHTTPS ? PRIVACY_ENCRYPTED : PRIVACY_FULL);
  },

  /**
   * on popup windows, the XULWindow's attributes seem not to be set correctly
   * we use thus JSDOMWindow attributes for sizemode and normal window attributes
   * (and hope for reasonable values when maximized/minimized - since then
   * outerWidth/outerHeight aren't the dimensions of the restored window)
   * @param aWindow
   *        Window reference
   * @param aAttribute
   *        String sizemode | width | height | other window attribute
   * @returns string
   */
  _getWindowDimension: function sss_getWindowDimension(aWindow, aAttribute) {
    var dimension = aWindow[WINDOW_ATTRIBUTES[aAttribute]];
    if (aAttribute == "sizemode") {
      switch (dimension) {
      case aWindow.STATE_MAXIMIZED:
        return "maximized";
      case aWindow.STATE_MINIMIZED:
        return "minimized";
      default:
        return "normal";
      }
    }

    if (aWindow.windowState == aWindow.STATE_NORMAL) {
      return dimension;
    }
    return aWindow.document.documentElement.getAttribute(aAttribute) || dimension;
  },

  /**
   * Get nsIURI from string
   * @param string
   * @returns nsIURI
   */
  _getURIFromString: function sss_getURIFromString(aString) {
    return Services.io.newURI(aString, null, null);
  },

  /**
   * Annotate a breakpad crash report with the currently selected tab's URL.
   */
  _updateCrashReportURL: function sss_updateCrashReportURL(aWindow) {
#ifdef MOZ_CRASH_REPORTER
    try {
      var currentURI = aWindow.getBrowser().currentURI.clone();
      // if the current URI contains a username/password, remove it
      try {
        currentURI.userPass = "";
      }
      catch (ex) { } // ignore failures on about: URIs

      CrashReporter.annotateCrashReport("URL", currentURI.spec);
    }
    catch (ex) {
      // don't make noise when crashreporter is built but not enabled
      if (ex.result != Components.results.NS_ERROR_NOT_INITIALIZED)
        debug(ex);
    }
#endif
  },

  /**
   * @param aState is a session state
   * @param aRecentCrashes is the number of consecutive crashes
   * @returns whether a restore page will be needed for the session state
   */
  _needsRestorePage: function sss_needsRestorePage(aState, aRecentCrashes) {
    const SIX_HOURS_IN_MS = 6 * 60 * 60 * 1000;

    // don't display the page when there's nothing to restore
    if (!aState.windows || !aState.windows.length)
      return false;

    // don't wrap a single about:sessionrestore page
    let winData = aState.windows;
    if (winData.length == 1 && winData[0].tabs &&
        winData[0].tabs.length == 1 && winData[0].tabs[0].entries &&
        winData[0].tabs[0].entries.length == 1 &&
        winData[0].tabs[0].entries[0].url == "about:sessionrestore")
      return false;

    // don't automatically restore in Safe Mode
    if (Services.appinfo.inSafeMode)
      return true;

    let max_resumed_crashes =
      this._prefBranch.getIntPref("sessionstore.max_resumed_crashes");
    let sessionAge = aState.session && aState.session.lastUpdate &&
                     (Date.now() - aState.session.lastUpdate);

    return max_resumed_crashes != -1 &&
           (aRecentCrashes > max_resumed_crashes ||
            sessionAge && sessionAge >= SIX_HOURS_IN_MS);
  },

  /**
   * Converts a JavaScript object into a JSON string
   * (see http://www.json.org/ for more information).
   *
   * The inverse operation consists of JSON.parse(JSON_string).
   *
   * @param aJSObject is the object to be converted
   * @returns the object's JSON representation
   */
  _toJSONString: function sss_toJSONString(aJSObject) {
    function exclude(key, value) {
      return value instanceof Components.interfaces.nsISupports ? undefined : value;
    }
    return JSON.stringify(aJSObject, exclude);
  },

  _sendRestoreCompletedNotifications: function sss_sendRestoreCompletedNotifications() {
    if (this._restoreCount) {
      this._restoreCount--;
      if (this._restoreCount == 0) {
        // This was the last window restored at startup, notify observers.
        Services.obs.notifyObservers(this.windowToFocus,
          this._browserSetState ? NOTIFY_BROWSER_STATE_RESTORED : NOTIFY_WINDOWS_RESTORED,
          "");
        this._browserSetState = false;
      }
    }
  },

  /**
   * @param aWindow
   *        Window reference
   * @returns whether this window's data is still cached in _statesToRestore
   *          because it's not fully loaded yet
   */
  _isWindowLoaded: function sss_isWindowLoaded(aWindow) {
    return !aWindow.__SS_restoreID;
  },

  /**
   * Replace "Loading..." with the tab label (with minimal side-effects)
   * @param aString is the string the title is stored in
   * @param aTabbrowser is a tabbrowser object, containing aTab
   * @param aTab is the tab whose title we're updating & using
   *
   * @returns aString that has been updated with the new title
   */
  _replaceLoadingTitle : function sss_replaceLoadingTitle(aString, aTabbrowser, aTab) {
    if (aString == aTabbrowser.mStringBundle.getString("tabs.loading")) {
      aTabbrowser.setTabTitle(aTab);
      [aString, aTab.label] = [aTab.label, aString];
    }
    return aString;
  },

  /**
   * Resize this._closedWindows to the value of the pref, except in the case
   * where we don't have any non-popup windows on Windows and Linux. Then we must
   * resize such that we have at least one non-popup window.
   */
  _capClosedWindows : function sss_capClosedWindows() {
    let maxWindowsUndo = this._prefBranch.getIntPref("sessionstore.max_windows_undo");
    if (this._closedWindows.length <= maxWindowsUndo)
      return;
    let spliceTo = maxWindowsUndo;
#ifndef XP_MACOSX
    let normalWindowIndex = 0;
    // try to find a non-popup window in this._closedWindows
    while (normalWindowIndex < this._closedWindows.length &&
           this._closedWindows[normalWindowIndex].isPopup)
      normalWindowIndex++;
    if (normalWindowIndex >= maxWindowsUndo)
      spliceTo = normalWindowIndex + 1;
#endif
    this._closedWindows.splice(spliceTo);
  },

/* ........ Storage API .............. */

  /**
   * write file to disk
   * @param aFile
   *        nsIFile
   * @param aData
   *        String data
   */
  _writeFile: function sss_writeFile(aFile, aData) {
    // Initialize the file output stream.
    var ostream = Components.classes["@mozilla.org/network/safe-file-output-stream;1"]
                            .createInstance(Components.interfaces.nsIFileOutputStream);
    ostream.init(aFile, 0x02 | 0x08 | 0x20, 0600, 0);

    // Obtain a converter to convert our data to a UTF-8 encoded input stream.
    var converter = Components.classes["@mozilla.org/intl/scriptableunicodeconverter"]
                              .createInstance(Components.interfaces.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";

    // Asynchronously copy the data to the file.
    var istream = converter.convertToInputStream(aData);
    var ObserverService = this._observerService;
    NetUtil.asyncCopy(istream, ostream, function(rc) {
      if (Components.isSuccessCode(rc)) {
        Services.obs.notifyObservers(null,
                                     "sessionstore-state-write-complete",
                                     "");
      }
    });
  }
};

let XPathHelper = {
  // these two hashes should be kept in sync
  namespaceURIs:     { "xhtml": "http://www.w3.org/1999/xhtml" },
  namespacePrefixes: { "http://www.w3.org/1999/xhtml": "xhtml" },

  /**
   * Generates an approximate XPath query to an (X)HTML node
   */
  generate: function sss_xph_generate(aNode) {
    // have we reached the document node already?
    if (!aNode.parentNode)
      return "";

    // Access localName, namespaceURI just once per node since it's expensive.
    let nNamespaceURI = aNode.namespaceURI;
    let nLocalName = aNode.localName;

    let prefix = this.namespacePrefixes[nNamespaceURI] || null;
    let tag = (prefix ? prefix + ":" : "") + this.escapeName(nLocalName);

    // stop once we've found a tag with an ID
    if (aNode.id)
      return "//" + tag + "[@id=" + this.quoteArgument(aNode.id) + "]";

    // count the number of previous sibling nodes of the same tag
    // (and possible also the same name)
    let count = 0;
    let nName = aNode.name || null;
    for (let n = aNode; (n = n.previousSibling); )
      if (n.localName == nLocalName && n.namespaceURI == nNamespaceURI &&
          (!nName || n.name == nName))
        count++;

    // recurse until hitting either the document node or an ID'd node
    return this.generate(aNode.parentNode) + "/" + tag +
           (nName ? "[@name=" + this.quoteArgument(nName) + "]" : "") +
           (count ? "[" + (count + 1) + "]" : "");
  },

  /**
   * Resolves an XPath query generated by XPathHelper.generate
   */
  resolve: function sss_xph_resolve(aDocument, aQuery) {
    let xptype = Components.interfaces.nsIDOMXPathResult.FIRST_ORDERED_NODE_TYPE;
    return aDocument.evaluate(aQuery, aDocument, this.resolveNS, xptype, null).singleNodeValue;
  },

  /**
   * Namespace resolver for the above XPath resolver
   */
  resolveNS: function sss_xph_resolveNS(aPrefix) {
    return XPathHelper.namespaceURIs[aPrefix] || null;
  },

  /**
   * @returns valid XPath for the given node (usually just the local name itself)
   */
  escapeName: function sss_xph_escapeName(aName) {
    // we can't just use the node's local name, if it contains
    // special characters (cf. bug 485482)
    return /^\w+$/.test(aName) ? aName :
           "*[local-name()=" + this.quoteArgument(aName) + "]";
  },

  /**
   * @returns a properly quoted string to insert into an XPath query
   */
  quoteArgument: function sss_xph_quoteArgument(aArg) {
    return !/'/.test(aArg) ? "'" + aArg + "'" :
           !/"/.test(aArg) ? '"' + aArg + '"' :
           "concat('" + aArg.replace(/'+/g, "',\"$&\",'") + "')";
  },

  /**
   * @returns an XPath query to all savable form field nodes
   */
  get restorableFormNodes() {
    // for a comprehensive list of all available <INPUT> types see
    // http://mxr.mozilla.org/mozilla-central/search?string=kInputTypeTable
    let ignoreTypes = ["password", "hidden", "button", "image", "submit", "reset"];
    // XXXzeniko work-around until lower-case has been implemented (bug 398389)
    let toLowerCase = '"ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"';
    let ignore = "not(translate(@type, " + toLowerCase + ")='" +
      ignoreTypes.join("' or translate(@type, " + toLowerCase + ")='") + "')";
    let formNodesXPath = "//textarea|//select|//xhtml:textarea|//xhtml:select|" +
      "//input[" + ignore + "]|//xhtml:input[" + ignore + "]";

    delete this.restorableFormNodes;
    return (this.restorableFormNodes = formNodesXPath);
  }
};

var NSGetFactory = XPCOMUtils.generateNSGetFactory([SessionStoreService]);
