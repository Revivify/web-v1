# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Services = object with smart getters for common XPCOM services
Components.utils.import("resource://gre/modules/Services.jsm");

function init(aEvent)
{
  if (aEvent.target != document)
    return;

  try {
    var distroId = Services.prefs.getCharPref("distribution.id");
    if (distroId) {
      var distroVersion = Services.prefs.getCharPref("distribution.version");

      var distroIdField = document.getElementById("distributionId");
      distroIdField.value = distroId + " - " + distroVersion;
      distroIdField.style.display = "block";

      try {
        // This is in its own try catch due to bug 895473 and bug 900925.
        var distroAbout = Services.prefs.getComplexValue("distribution.about",
          Components.interfaces.nsISupportsString);
        var distroField = document.getElementById("distribution");
        distroField.value = distroAbout;
        distroField.style.display = "block";
      }
      catch (ex) {
        // Pref is unset
        Components.utils.reportError(ex);
      }
    }
  }
  catch (e) {
    // Pref is unset
  }

  // XXX FIXME
  // Include the build ID and display warning if this is an "a#" (nightly or aurora) build
  let version = Services.appinfo.version;
  if (/a\d+$/.test(version)) {
    let buildID = Services.appinfo.appBuildID;
    let buildDate = buildID.slice(0,4) + "-" + buildID.slice(4,6) + "-" + buildID.slice(6,8);
    document.getElementById("version").textContent += " (" + buildDate + ")";
    document.getElementById("experimental").hidden = false;
    document.getElementById("communityDesc").hidden = true;
  }

#ifdef MOZ_UPDATER
  gAppUpdater = new appUpdater();

  let defaults = Services.prefs.getDefaultBranch("");
  let channelLabel = document.getElementById("currentChannel");
  channelLabel.value = defaults.getCharPref("app.update.channel");
#endif

#ifdef XP_MACOSX
  // it may not be sized at this point, and we need its width to calculate its position
  window.sizeToContent();
  window.moveTo((screen.availWidth / 2) - (window.outerWidth / 2), screen.availHeight / 5);
#endif
}

// This function is used to open about: tabs. The caller should ensure the url
// is only an about: url.
function openAboutTab(url)
{
  let tabmail;
  // Check existing windows
  let mailWindow = Services.wm.getMostRecentWindow("mail:3pane");
  if (mailWindow) {
    mailWindow.focus();
    mailWindow.document.getElementById("tabmail")
              .openTab("contentTab", {contentPage: url,
                                      clickHandler: "specialTabs.aboutClickHandler(event);"});
    return;
  }

  // No existing windows.
  window.openDialog("chrome://messenger/content/", "_blank",
                    "chrome,dialog=no,all", null,
                    { tabType: "contentTab",
                      tabParams: {contentPage: url, clickHandler: "specialTabs.aboutClickHandler(event);"} });
}

function openUILink(url, event)
{
  if (!event.button) {
    let m = ("messenger" in window) ? messenger :
      Components.classes["@mozilla.org/messenger;1"]
                .createInstance(Components.interfaces.nsIMessenger);
    m.launchExternalURL(url);
    event.preventDefault();
  }
}

#ifdef MOZ_UPDATER
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/DownloadUtils.jsm");

var gAppUpdater;

function onUnload(aEvent) {
  if (gAppUpdater.isChecking)
    gAppUpdater.checker.stopChecking(Components.interfaces.nsIUpdateChecker.CURRENT_CHECK);
  // Safe to call even when there isn't a download in progress.
  gAppUpdater.removeDownloadListener();
  gAppUpdater = null;
}


function appUpdater()
{
  this.updateDeck = document.getElementById("updateDeck");

  // Hide the update deck when there is already an update window open to avoid
  // syncing issues between them.
  if (Services.wm.getMostRecentWindow("Update:Wizard")) {
    this.updateDeck.hidden = true;
    return;
  }

  XPCOMUtils.defineLazyServiceGetter(this, "aus",
                                     "@mozilla.org/updates/update-service;1",
                                     "nsIApplicationUpdateService");
  XPCOMUtils.defineLazyServiceGetter(this, "checker",
                                     "@mozilla.org/updates/update-checker;1",
                                     "nsIUpdateChecker");
  XPCOMUtils.defineLazyServiceGetter(this, "um",
                                     "@mozilla.org/updates/update-manager;1",
                                     "nsIUpdateManager");

  this.bundle = Services.strings.
                createBundle("chrome://messenger/locale/messenger.properties");

  let manualURL = Services.urlFormatter.formatURLPref("app.update.url.manual");
  document.getElementById("manualLink")
          .setAttribute("onclick", 'openURL("' + manualURL + '");');
  document.getElementById("failedLink")
          .setAttribute("onclick", 'openURL("' + manualURL + '");');

  if (this.updateDisabledAndLocked) {
    this.selectPanel("adminDisabled");
    return;
  }

  if (this.isPending || this.isApplied) {
    this.selectPanel("apply");
    return;
  }

  if (this.aus.isOtherInstanceHandlingUpdates) {
    this.selectPanel("otherInstanceHandlingUpdates");
    return;
  }

  if (this.isDownloading) {
    this.startDownload();
    // selectPanel("downloading") is called from setupDownloadingUI().
    return;
  }

  // Honor the "Never check for updates" option by not only disabling background
  // update checks, but also in the About dialog, by presenting a
  // "Check for updates" button.
  // If updates are found, the user is then asked if he wants to "Update to <version>".
  if (!this.updateEnabled) {
    this.selectPanel("checkForUpdates");
    return;
  }

  // That leaves the options
  // "Check for updates, but let me choose whether to install them", and
  // "Automatically install updates".
  // In both cases, we check for updates without asking.
  // In the "let me choose" case, we ask before downloading though, in onCheckComplete.
  this.checkForUpdates();
}

appUpdater.prototype =
{
  // true when there is an update check in progress.
  isChecking: false,

  // true when there is an update already staged / ready to be applied.
  get isPending() {
    if (this.update) {
      return this.update.state == "pending" ||
             this.update.state == "pending-service";
    }
    return this.um.activeUpdate &&
           (this.um.activeUpdate.state == "pending" ||
            this.um.activeUpdate.state == "pending-service");
  },

  // true when there is an update already installed in the background.
  get isApplied() {
    if (this.update) {
      return this.update.state == "applied" ||
             this.update.state == "applied-service";
    }
    return this.um.activeUpdate &&
           (this.um.activeUpdate.state == "applied" ||
            this.um.activeUpdate.state == "applied-service");
  },

  // true when there is an update download in progress.
  get isDownloading() {
    if (this.update)
      return this.update.state == "downloading";
    return this.um.activeUpdate &&
           this.um.activeUpdate.state == "downloading";
  },

  // true when updating is disabled by an administrator.
  get updateDisabledAndLocked() {
    return !this.updateEnabled &&
           Services.prefs.prefIsLocked("app.update.enabled");
  },

  // true when updating is enabled.
  get updateEnabled() {
    try {
      return Services.prefs.getBoolPref("app.update.enabled");
    }
    catch (e) { }
    return true; // Thunderbird default is true
  },

  // true when updating in background is enabled.
  get backgroundUpdateEnabled() {
    return this.updateEnabled &&
           gAppUpdater.aus.canStageUpdates;
  },

  // true when updating is automatic.
  get updateAuto() {
    try {
      return Services.prefs.getBoolPref("app.update.auto");
    }
    catch (e) { }
    return true; // Thunderbird default is true
  },

  /**
   * Sets the panel of the updateDeck.
   *
   * @param  aChildID
   *         The id of the deck's child to select, e.g. "apply".
   */
  selectPanel: function(aChildID) {
    let panel = document.getElementById(aChildID);

    let button = panel.querySelector("button");
    if (button) {
      if (aChildID == "downloadAndInstall") {
        let updateVersion = gAppUpdater.update.displayVersion;
        button.label = this.bundle.formatStringFromName("update.downloadAndInstallButton.label", [updateVersion], 1);
        button.accessKey = this.bundle.GetStringFromName("update.downloadAndInstallButton.accesskey");
      }
      this.updateDeck.selectedPanel = panel;
      if (!document.commandDispatcher.focusedElement || // don't steal the focus
          document.commandDispatcher.focusedElement.localName == "button") // except from the other buttons
        button.focus();

    } else {
      this.updateDeck.selectedPanel = panel;
    }
  },

  /**
   * Check for updates
   */
  checkForUpdates: function() {
    this.selectPanel("checkingForUpdates");
    this.isChecking = true;
    this.checker.checkForUpdates(this.updateCheckListener, true);
    // after checking, onCheckComplete() is called
  },

  /**
   * Handles oncommand for the "Restart to Update" button
   * which is presented after the download has been downloaded.
   */
  buttonRestartAfterDownload: function() {
    if (!this.isPending && !this.isApplied)
      return;

      // Notify all windows that an application quit has been requested.
      let cancelQuit = Components.classes["@mozilla.org/supports-PRBool;1"].
                       createInstance(Components.interfaces.nsISupportsPRBool);
      Services.obs.notifyObservers(cancelQuit, "quit-application-requested", "restart");

      // Something aborted the quit process.
      if (cancelQuit.data)
        return;

      let appStartup = Components.classes["@mozilla.org/toolkit/app-startup;1"].
                       getService(Components.interfaces.nsIAppStartup);

      // If already in safe mode restart in safe mode (bug 327119)
      if (Services.appinfo.inSafeMode) {
        appStartup.restartInSafeMode(Components.interfaces.nsIAppStartup.eAttemptQuit);
        return;
      }

      appStartup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit |
                      Components.interfaces.nsIAppStartup.eRestart);
    },

  /**
   * Handles oncommand for the "Apply Update…" button
   * which is presented if we need to show the billboard.
   */
  buttonApplyBillboard: function() {
    const URI_UPDATE_PROMPT_DIALOG = "chrome://mozapps/content/update/updates.xul";
    var ary = null;
    ary = Components.classes["@mozilla.org/supports-array;1"].
          createInstance(Components.interfaces.nsISupportsArray);
    ary.AppendElement(this.update);
    var openFeatures = "chrome,centerscreen,dialog=no,resizable=no,titlebar,toolbar=no";
    Services.ww.openWindow(null, URI_UPDATE_PROMPT_DIALOG, "", openFeatures, ary);
    window.close(); // close the "About" window; updates.xul takes over.
  },

  /**
   * Implements nsIUpdateCheckListener. The methods implemented by
   * nsIUpdateCheckListener are in a different scope from nsIIncrementalDownload
   * to make it clear which are used by each interface.
   */
  updateCheckListener: {
    /**
     * See nsIUpdateService.idl
     */
    onCheckComplete: function(aRequest, aUpdates, aUpdateCount) {
      gAppUpdater.isChecking = false;
      gAppUpdater.update = gAppUpdater.aus.
                           selectUpdate(aUpdates, aUpdates.length);
      if (!gAppUpdater.update) {
        gAppUpdater.selectPanel("noUpdatesFound");
        return;
      }

      if (gAppUpdater.update.unsupported) {
        let unsupportedLink = document.getElementById("unsupportedLink");
        if (gAppUpdater.update.detailsURL)
          unsupportedLink.href = gAppUpdater.update.detailsURL;
        else
          unsupportedLink.setAttribute("hidden", true);

        gAppUpdater.selectPanel("unsupportedSystem");
        return;
      }

      if (!gAppUpdater.aus.canApplyUpdates) {
        gAppUpdater.selectPanel("manualUpdate");
        return;
      }

      if (gAppUpdater.update.billboardURL) {
        gAppUpdater.selectPanel("applyBillboard");
        return;
      }

      if (gAppUpdater.updateAuto) // automatically download and install
        gAppUpdater.startDownload();
      else // ask
        gAppUpdater.selectPanel("downloadAndInstall");
    },

    /**
     * See nsIUpdateService.idl
     */
    onError: function(aRequest, aUpdate) {
      // Errors in the update check are treated as no updates found. If the
      // update check fails repeatedly without a success the user will be
      // notified with the normal app update user interface so this is safe.
      gAppUpdater.isChecking = false;
      gAppUpdater.selectPanel("noUpdatesFound");
      return;
    },

    /**
     * See nsISupports.idl
     */
    QueryInterface: function(aIID) {
      if (!aIID.equals(Components.interfaces.nsIUpdateCheckListener) &&
          !aIID.equals(Components.interfaces.nsISupports))
        throw Components.results.NS_ERROR_NO_INTERFACE;
      return this;
    }
  },

  /**
   * Starts the download of an update mar.
   */
  startDownload: function() {
    if (!this.update)
      this.update = this.um.activeUpdate;
    this.update.QueryInterface(Components.interfaces.nsIWritablePropertyBag);
    this.update.setProperty("foregroundDownload", "true");

    this.aus.pauseDownload();
    let state = this.aus.downloadUpdate(this.update, false);
    if (state == "failed") {
      this.selectPanel("downloadFailed");
      return;
    }

    this.setupDownloadingUI();
  },

  /**
   * Switches to the UI responsible for tracking the download.
   */
  setupDownloadingUI: function() {
    this.downloadStatus = document.getElementById("downloadStatus");
    this.downloadStatus.value =
      DownloadUtils.getTransferTotal(0, this.update.selectedPatch.size);
    this.selectPanel("downloading");
    this.aus.addDownloadListener(this);
  },

  removeDownloadListener: function() {
    if (this.aus) {
      this.aus.removeDownloadListener(this);
    }
  },

  /**
   * See nsIRequestObserver.idl
   */
  onStartRequest: function(aRequest, aContext) {
  },

  /**
   * See nsIRequestObserver.idl
   */
  onStopRequest: function(aRequest, aContext, aStatusCode) {
    switch (aStatusCode) {
    case Components.results.NS_ERROR_UNEXPECTED:
      if (this.update.selectedPatch.state == "download-failed" &&
          (this.update.isCompleteUpdate || this.update.patchCount != 2)) {
        // Verification error of complete patch, informational text is held in
        // the update object.
        this.removeDownloadListener();
        this.selectPanel("downloadFailed");
        break;
      }
      // Verification failed for a partial patch, complete patch is now
      // downloading so return early and do NOT remove the download listener!
      break;
    case Components.results.NS_BINDING_ABORTED:
      // Do not remove UI listener since the user may resume downloading again.
      break;
    case Components.results.NS_OK:
      this.removeDownloadListener();
      if (this.backgroundUpdateEnabled) {
        this.selectPanel("applying");
        let update = this.um.activeUpdate;
        let self = this;
        Services.obs.addObserver(function selectPanelOnUpdate(aSubject, aTopic, aData) {
          // Update the UI when the background updater is finished
          let status = aData;
          if (status == "applied" || status == "applied-service" ||
              status == "pending" || status == "pending-service") {
            // If the update is successfully applied, or if the updater has
            // fallen back to non-staged updates, show the "Restart to Update"
            // button.
            self.selectPanel("apply");
          } else if (status == "failed") {
            // Background update has failed, let's show the UI responsible for
            // prompting the user to update manually.
            self.selectPanel("downloadFailed");
          } else if (status == "downloading") {
            // We've fallen back to downloading the full update because the
            // partial update failed to get staged in the background.
            // Therefore we need to keep our observer.
            self.setupDownloadingUI();
            return;
          }
          Services.obs.removeObserver(selectPanelOnUpdate, "update-staged");
        }, "update-staged", false);
      } else {
        this.selectPanel("apply");
      }
      break;
    default:
      this.removeDownloadListener();
      this.selectPanel("downloadFailed");
      break;
    }
  },

  /**
   * See nsIProgressEventSink.idl
   */
  onStatus: function(aRequest, aContext, aStatus, aStatusArg) {
  },

  /**
   * See nsIProgressEventSink.idl
   */
  onProgress: function(aRequest, aContext, aProgress, aProgressMax) {
    this.downloadStatus.value =
      DownloadUtils.getTransferTotal(aProgress, aProgressMax);
  },

  /**
   * See nsISupports.idl
   */
  QueryInterface: function(aIID) {
    if (!aIID.equals(Components.interfaces.nsIProgressEventSink) &&
        !aIID.equals(Components.interfaces.nsIRequestObserver) &&
        !aIID.equals(Components.interfaces.nsISupports))
      throw Components.results.NS_ERROR_NO_INTERFACE;
    return this;
  }
};
#endif
