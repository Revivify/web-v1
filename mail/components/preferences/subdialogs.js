/* - This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this file,
   - You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let gSubDialog = {
  _closingCallback: null,
  _closingEvent: null,
  _isClosing: false,
  _frame: null,
  _overlay: null,
  _box: null,
  _injectedStyleSheets: ["chrome://mozapps/content/preferences/preferences.css",
                         "chrome://messenger/skin/preferences/preferences.css",
                         "chrome://global/skin/in-content/common.css",
                         "chrome://messenger/skin/preferences/aboutPreferences.css",
                         "chrome://messenger/skin/preferences/dialog.css"],

  // Store the original instantApply pref for restoring after closing the dialog
  _instantApplyOrig: Services.prefs.getBoolPref("browser.preferences.instantApply"),

  init: function() {
    this._frame = document.getElementById("dialogFrame");
    this._overlay = document.getElementById("dialogOverlay");
    this._box = document.getElementById("dialogBox");
    this._closeButton = document.getElementById("dialogClose");
  },

  updateTitle: function(aEvent) {
    if (aEvent.target != gSubDialog._frame.contentDocument)
      return;
    document.getElementById("dialogTitle").textContent = gSubDialog._frame.contentDocument.title;
  },

  injectXMLStylesheet: function(aStylesheetURL) {
    let contentStylesheet = this._frame.contentDocument.createProcessingInstruction(
      'xml-stylesheet',
      'href="' + aStylesheetURL + '" type="text/css"'
    );
    this._frame.contentDocument.insertBefore(contentStylesheet,
                                             this._frame.contentDocument.documentElement);
  },

  open: function(aURL, aFeatures = null, aParams = null, aClosingCallback = null) {
    this._addDialogEventListeners();

    Services.prefs.setBoolPref("browser.preferences.instantApply", true);
    let features = (!!aFeatures ? aFeatures + "," : "") + "resizable,dialog=no,centerscreen";
    let dialog = window.openDialog(aURL, "dialogFrame", features, aParams);
    if (aClosingCallback) {
      this._closingCallback = aClosingCallback.bind(dialog);
    }

    this._closingEvent = null;
    this._isClosing = false;

    features = features.replace(/,/g, "&");
    let featureParams = new URLSearchParams(features.toLowerCase());
    this._box.setAttribute("resizable", featureParams.has("resizable") &&
                                        featureParams.get("resizable") != "no" &&
                                        featureParams.get("resizable") != "0");
    return dialog;
  },

  close: function(aEvent = null) {
    if (this._isClosing) {
      return;
    }
    this._isClosing = true;

    if (this._closingCallback) {
      try {
        this._closingCallback.call(null, aEvent);
      } catch (ex) {
        Cu.reportError(ex);
      }
      this._closingCallback = null;
    }

    Services.prefs.setBoolPref("browser.preferences.instantApply", this._instantApplyOrig);
    this._removeDialogEventListeners();

    this._overlay.style.visibility = "";
    // Clear the sizing inline styles.
    this._frame.removeAttribute("style");
    // Clear the sizing attributes
    this._box.removeAttribute("width");
    this._box.removeAttribute("height");
    this._box.style.removeProperty("min-height");
    this._box.style.removeProperty("min-width");

    setTimeout(() => {
      // Unload the dialog after the event listeners run so that the load of about:blank isn't
      // cancelled by the ESC <key>.
      this._frame.loadURI("about:blank");
    }, 0);
  },

  handleEvent: function(aEvent) {
    switch (aEvent.type) {
      case "command":
        this.close(aEvent);
        break;
      case "dialogclosing":
        this._onDialogClosing(aEvent);
        break;
      case "DOMTitleChanged":
        this.updateTitle(aEvent);
        break;
      case "DOMFrameContentLoaded":
        this._onContentLoaded(aEvent);
        break;
      case "load":
        this._onLoad(aEvent);
        break;
      case "unload":
        this._onUnload(aEvent);
        break;
      case "keydown":
        this._onKeyDown(aEvent);
        break;
      case "focus":
        this._onParentWinFocus(aEvent);
        break;
    }
  },

  /* Private methods */

  _onUnload: function(aEvent) {
    if (aEvent.target.location.href != "about:blank") {
      this.close(this._closingEvent);
    }
  },

  _onContentLoaded: function(aEvent) {
    if (aEvent.target != this._frame || aEvent.target.contentWindow.location == "about:blank")
      return;

    for (let styleSheetURL of this._injectedStyleSheets) {
      this.injectXMLStylesheet(styleSheetURL);
    }

    this._frame.contentWindow.addEventListener("dialogclosing", this);

    // Make window.close calls work like dialog closing.
    let oldClose = this._frame.contentWindow.close;
    this._frame.contentWindow.close = function() {
      var closingEvent = gSubDialog._closingEvent;
      if (!closingEvent) {
        closingEvent = new CustomEvent("dialogclosing", {
          bubbles: true,
          detail: { button: null },
        });

        gSubDialog._frame.contentWindow.dispatchEvent(closingEvent);
      }

      gSubDialog.close(closingEvent);
      oldClose.call(gSubDialog._frame.contentWindow);
    };

    // XXX: Hack to make focus during the dialog's load functions work. Make the element visible
    // sooner in DOMContentLoaded but mostly invisible instead of changing visibility just before
    // the dialog's load event.
    this._overlay.style.visibility = "visible";
    this._overlay.style.opacity = "0.01";
  },

  _onLoad: function(aEvent) {
    if (aEvent.target.contentWindow.location == "about:blank")
      return;

    // Do this on load to wait for the CSS to load and apply before calculating the size.
    let docEl = this._frame.contentDocument.documentElement;

    let groupBoxTitle = document.getAnonymousElementByAttribute(this._box, "class", "groupbox-title");
    let groupBoxTitleHeight = groupBoxTitle.clientHeight +
                              parseFloat(getComputedStyle(groupBoxTitle).borderBottomWidth);

    let groupBoxBody = document.getAnonymousElementByAttribute(this._box, "class", "groupbox-body");
    let boxVerticalPadding = 2 * parseFloat(getComputedStyle(groupBoxBody).paddingTop);
    let boxHorizontalPadding = 2 * parseFloat(getComputedStyle(groupBoxBody).paddingLeft);
    let frameWidth = docEl.style.width || docEl.scrollWidth + "px";
    let frameHeight = docEl.style.height || docEl.scrollHeight + "px";
    let boxVerticalBorder = 2 * parseFloat(getComputedStyle(this._box).borderTopWidth);
    let boxHorizontalBorder = 2 * parseFloat(getComputedStyle(this._box).borderLeftWidth);

    let frameRect = this._frame.getBoundingClientRect();
    let boxRect = this._box.getBoundingClientRect();
    let frameSizeDifference = (frameRect.top - boxRect.top) + (boxRect.bottom - frameRect.bottom);

    // Now check if the frame height we calculated is possible at this window size,
    // accounting for titlebar, padding/border and some spacing.
    let maxHeight = window.innerHeight - frameSizeDifference - 30;
    if (frameHeight > maxHeight) {
      // If not, we should probably let the dialog scroll:
      frameHeight = maxHeight;
      let containers = this._frame.contentDocument.querySelectorAll('.largeDialogContainer');
      for (let container of containers) {
        container.classList.add("doScroll");
      }
    }

    this._frame.style.width = frameWidth;
    this._frame.style.height = frameHeight;
    this._box.style.minHeight = "calc(" +
                                (boxVerticalBorder + groupBoxTitleHeight + boxVerticalPadding) +
                                "px + " + frameHeight + ")";
    this._box.style.minWidth = "calc(" +
                               (boxHorizontalBorder + boxHorizontalPadding) +
                               "px + " + frameWidth + ")";

    this._overlay.style.visibility = "visible";
    this._overlay.style.opacity = ""; // XXX: focus hack continued from _onContentLoaded

    this._trapFocus();
  },

  _onDialogClosing: function(aEvent) {
    this._frame.contentWindow.removeEventListener("dialogclosing", this);
    this._closingEvent = aEvent;
  },

  _onKeyDown: function(aEvent) {
    if (aEvent.currentTarget == window && aEvent.keyCode == aEvent.DOM_VK_ESCAPE &&
        !aEvent.defaultPrevented) {
      this.close(aEvent);
      return;
    }
    if (aEvent.keyCode != aEvent.DOM_VK_TAB ||
        aEvent.ctrlKey || aEvent.altKey || aEvent.metaKey) {
      return;
    }

    let fm = Services.focus;

    function isLastFocusableElement(el) {
      //XXXgijs unfortunately there is no way to get the last focusable element without asking
      // the focus manager to move focus to it.
      let rv = el == fm.moveFocus(gSubDialog._frame.contentWindow, null, fm.MOVEFOCUS_LAST, 0);
      fm.setFocus(el, 0);
      return rv;
    }

    let forward = !aEvent.shiftKey;
    // check if focus is leaving the frame (incl. the close button):
    if ((aEvent.target == this._closeButton && !forward) ||
        (isLastFocusableElement(aEvent.originalTarget) && forward)) {
      aEvent.preventDefault();
      aEvent.stopImmediatePropagation();
      let parentWin = this._getBrowser().ownerDocument.defaultView;
      if (forward) {
        fm.moveFocus(parentWin, null, fm.MOVEFOCUS_FIRST, fm.FLAG_BYKEY);
      } else {
        // Somehow, moving back 'past' the opening doc is not trivial. Cheat by doing it in 2 steps:
        fm.moveFocus(window, null, fm.MOVEFOCUS_ROOT, fm.FLAG_BYKEY);
        fm.moveFocus(parentWin, null, fm.MOVEFOCUS_BACKWARD, fm.FLAG_BYKEY);
      }
    }
  },

  _onParentWinFocus: function(aEvent) {
    // Explicitly check for the focus target of |window| to avoid triggering this when the window
    // is refocused
    if (aEvent.target != this._closeButton && aEvent.target != window) {
      this._closeButton.focus();
    }
  },

  _addDialogEventListeners: function() {
    // Make the close button work.
    this._closeButton.addEventListener("command", this);

    // DOMTitleChanged isn't fired on the frame, only on the chromeEventHandler
    let chromeBrowser = this._getBrowser();
    chromeBrowser.addEventListener("DOMTitleChanged", this, true);

    // Similarly DOMFrameContentLoaded only fires on the top window
    window.addEventListener("DOMFrameContentLoaded", this, true);

    // Wait for the stylesheets injected during DOMContentLoaded to load before showing the dialog
    // otherwise there is a flicker of the stylesheet applying.
    this._frame.addEventListener("load", this);

    chromeBrowser.addEventListener("unload", this, true);
    // Ensure we get <esc> keypresses even if nothing in the subdialog is focusable
    // (happens on OS X when only text inputs and lists are focusable, and
    //  the subdialog only has checkboxes/radiobuttons/buttons)
    window.addEventListener("keydown", this, true);
  },

  _removeDialogEventListeners: function() {
    let chromeBrowser = this._getBrowser();
    chromeBrowser.removeEventListener("DOMTitleChanged", this, true);
    chromeBrowser.removeEventListener("unload", this, true);

    this._closeButton.removeEventListener("command", this);

    window.removeEventListener("DOMFrameContentLoaded", this, true);
    this._frame.removeEventListener("load", this);
    this._frame.contentWindow.removeEventListener("dialogclosing", this);
    window.removeEventListener("keydown", this, true);
    this._untrapFocus();
  },

  _trapFocus: function() {
    let fm = Services.focus;
    fm.moveFocus(this._frame.contentWindow, null, fm.MOVEFOCUS_FIRST, 0);
    this._frame.contentDocument.addEventListener("keydown", this, true);
    this._closeButton.addEventListener("keydown", this);

    window.addEventListener("focus", this, true);
  },

  _untrapFocus: function() {
    this._frame.contentDocument.removeEventListener("keydown", this, true);
    this._closeButton.removeEventListener("keydown", this);
    window.removeEventListener("focus", this);
  },

  _getBrowser: function() {
    return window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                 .getInterface(Components.interfaces.nsIWebNavigation)
                 .QueryInterface(Components.interfaces.nsIDocShell)
                 .chromeEventHandler;
  },
};
