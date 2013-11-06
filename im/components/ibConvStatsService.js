/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("resource:///modules/imServices.jsm");
Cu.import("resource://gre/modules/osfile.jsm");

const kNotificationsToObserve =
  ["contact-added", "contact-removed","contact-status-changed",
   "contact-display-name-changed", "contact-no-longer-dummy",
   "contact-preferred-buddy-changed", "contact-moved",
   "account-connected", "account-disconnected", "new-conversation",
   "new-text", "conversation-closed", "prpl-quit"];

// This is incremented when changes to the log sweeping code warrant rebuilding
// the stats cache file.
const gStatsCacheVersion = 1;

XPCOMUtils.defineLazyGetter(this, "_newtab", function()
  l10nHelper("chrome://instantbird/locale/newtab.properties")
);

XPCOMUtils.defineLazyGetter(this, "_instantbird", function()
  l10nHelper("chrome://instantbird/locale/instantbird.properties")
);

// ConversationStats stored by id.
// A PossibleConversation's id is its protocol, account, and name joined by "/", suffixed
// with ".chat" for MUCs (identical to the log folder path for the conversation).
var gStatsByConvId = {};

// The message counts of a contact are the sums of the message counts of the
// linked buddies.
// This object serves as a cache for the total stats of contacts.
// Initialized when gStatsByConvId is ready (i.e. all log files have been parsed
// or it was loaded from the JSON cache file).
var gStatsByContactId;

// Recursively sweeps log folders and parses log files for conversation statistics.
var gLogParser = {
  _statsService: null,
  _accounts: [],
  _logFolders: [],

  // The general path of a log is logs/prpl/account/conv/date.json.
  // First, sweep the logs folder for prpl folders.
  sweep: function(aStatsService) {
    this._statsService = aStatsService;
    initLogModule("stats-service-log-sweeper", this);
    let logsPath = OS.Path.join(OS.Constants.Path.profileDir, "logs");
    let iterator = new OS.File.DirectoryIterator(logsPath);
    iterator.nextBatch().then((function(aEntries) {
      // Filter out any stray files (e.g. system files).
      aEntries = aEntries.filter(function(e) e.isDir);
      this._sweepPrpls(aEntries);
    }).bind(this), function(aError) {
      Cu.reportError("Error while sweeping logs folder: " + logsPath + "\n" + aError);
    });
  },

  // Sweep each prpl folder for account folders, and add them to this._accounts.
  _sweepPrpls: function(aPrpls) {
    if (!aPrpls.length)
      this._sweepAccounts();
    let path = aPrpls.shift().path;
    let iterator = new OS.File.DirectoryIterator(path);
    iterator.nextBatch().then((function(aEntries) {
      // Filter out any stray files (e.g. system files).
      aEntries = aEntries.filter(function(e) e.isDir);
      this._accounts = this._accounts.concat(aEntries);
      if (aPrpls.length)
        this._sweepPrpls(aPrpls);
      else
        this._sweepAccounts();
    }).bind(this), function(aError) {
      Cu.reportError("Error while sweeping prpl folder: " + path + "\n" + aError);
    });
  },

  // Sweep each account folder for conversation log folders, add them to this._logFolders.
  _sweepAccounts: function() {
    let path = this._accounts.shift().path;
    let iterator = new OS.File.DirectoryIterator(path);
    iterator.nextBatch().then((function(aEntries) {
      // Filter out any stray files (e.g. system files).
      aEntries = aEntries.filter(function(e) e.isDir);
      this._logFolders = this._logFolders.concat(aEntries);
      if (this._accounts.length)
        this._sweepAccounts();
      else
        this._sweepLogFolders();
    }).bind(this), function(aError) {
      Cu.reportError("Error while sweeping account folder: " + path + "\n" + aError);
    });
  },

  // Call _sweepLogFolder on the contents of each log folder.
  _sweepLogFolders: function() {
    let path = this._logFolders.shift().path;
    let iterator = new OS.File.DirectoryIterator(path);
    iterator.nextBatch().then(this._sweepLogFolder.bind(this), function(aError) {
      Cu.reportError("Error while sweeping log folder: " + path + "\n" + aError);
    });
  },

  // Goes through JSON log files in each log folder and parses them for stats.
  _sweepLogFolder: function(aLogs) {
    aLogs = aLogs.filter(function(l) l.name.endsWith(".json"));
    let decoder = new TextDecoder();
    let __sweepLogFolder = function() {
      if (!aLogs.length) {
        if (this._logFolders.length)
          this._sweepLogFolders();
        else { // We're done.
          let statsService = this._statsService;
          statsService._cacheAllStats(); // Flush stats to JSON cache.
          statsService._convs.sort(statsService._sortComparator);
          gStatsByContactId = {}; // Initialize stats cache for contacts.
        }
        return;
      }
      let log = aLogs.shift().path;
      OS.File.read(log).then(function(aArray) {
        // Try to parse the log file. If anything goes wrong here, the log file
        // has likely been tampered with so we ignore it and move on.
        try {
          let lines = decoder.decode(aArray).split("\n");
          // The first line is the header which identifies the conversation.
          let header = JSON.parse(lines.shift());
          let name = header.name;
          let protocol = header.protocol;
          let account = header.account;
          let date = Date.parse(header.date);
          let id = getConversationId(protocol, account, name, header.isChat);
          if (!(id in gStatsByConvId))
            gStatsByConvId[id] = new ConversationStats(id);
          let stats = gStatsByConvId[id];
          lines.pop(); // Ignore the final line break.
          for (let line of lines) {
            line = JSON.parse(line);
            if (line.flags[0] == "system") // Ignore system messages.
              continue;
            line.flags[0] == "incoming" ?
              ++stats.incomingCount : ++stats.outgoingCount;
          }
          if (date > stats.lastDate)
            stats.lastDate = date;
        }
        catch(e) {
          this.WARN("Error parsing log file: " + log + "\n" + e);
        }
        __sweepLogFolder();
      }.bind(this), function(aError) {
        Cu.reportError("Error reading log file: " + log + "\n" + aError);
        __sweepLogFolder();
      });
    }.bind(this);
    __sweepLogFolder();
  }
};

function ConvStatsService() {
  this._observers = [];
}
ConvStatsService.prototype = {
  // Sorted list of conversations, stored as PossibleConversations.
  _convs: [],
  // PossibleConvFromContacts stored by id.
  _contactsById: new Map(),
  // Keys are account ids. Values are Maps of chat names to PossibleChats.
  _chatsByAccountIdAndName: new Map(),
  // Timer to update the stats cache.
  // The cache is updated every 10 minutes, and on quitting.
  _statsCacheUpdateTimer: null,
  _statsCacheFilePath: null,

  _init: function() {
    let contacts = Services.contacts.getContacts();
    for (let contact of contacts)
      this._addContact(contact);
    for (let notification of kNotificationsToObserve)
      Services.obs.addObserver(this, notification, false);

    // Read all our conversation stats from the cache.
    this._statsCacheFilePath =
      OS.Path.join(OS.Constants.Path.profileDir, "statsservicecache.json");
    OS.File.read(this._statsCacheFilePath).then(function(aArray) {
      try {
        let {version: version, stats: stats} =
          JSON.parse((new TextDecoder()).decode(aArray));
        if (version !== gStatsCacheVersion) {
          gLogParser.sweep(this);
          return;
        }
        gStatsByConvId = stats;
        for each (let stats in gStatsByConvId)
          stats.__proto__ = ConversationStats.prototype;
        gStatsByContactId = {};
      }
      catch (e) {
        // Something unexpected was encountered in the file.
        // (Maybe it was tampered with?) Rebuild the cache from logs.
        Cu.reportError("Error while parsing conversation stats cache.\n" + e);
        if (Services.prefs.getBoolPref("statsService.parseLogsForStats"))
          gLogParser.sweep(this);
      }
    }.bind(this), function(aError) {
      if (!aError.becauseNoSuchFile)
        Cu.reportError("Error while reading conversation stats cache.\n" + aError);
      if (Services.prefs.getBoolPref("statsService.parseLogsForStats"))
        gLogParser.sweep(this);
    }.bind(this));
  },

  _addContact: function(aContact) {
    if (this._contactsById.has(aContact.id)) // Already added.
      return;
    let possibleConv = new PossibleConvFromContact(aContact);
    let pos = this._getPositionToInsert(possibleConv, this._convs);
    this._convs.splice(pos, 0, possibleConv);
    this._contactsById.set(aContact.id, possibleConv);
  },

  _removeContact: function(aId) {
    if (!this._contactsById.has(aId))
      return;
    this._convs.splice(
      this._convs.indexOf(this._contactsById.get(aId)), 1);
    this._contactsById.delete(aId);
  },

  // Queue of RoomInfo to be added.
  _pendingChats: [],
  // The last time an update notification was sent to observers.
  _lastUpdateNotification: 0,
  // Account ids from which chat room info has been requested.
  // We send an update notification if this is empty after adding chat rooms.
  _accountsRequestingRoomInfo: new Set(),
  _addPendingChats: function() {
    let begin = Date.now();
    for (let time = 0; time < 15 && this._pendingChats.length;
         time = Date.now() - begin) {
      let chat = this._pendingChats.pop();
      let accountId = chat.accountId;
      let chatList = this._chatsByAccountIdAndName.get(accountId);
      if (!chatList) {
        chatList = new Map();
        this._chatsByAccountIdAndName.set(accountId, chatList);
      }
      // If a chat is already added, we remove it and re-add to refresh.
      else if (chatList.has(chat.name)) {
        this._convs.splice(
          this._convs.indexOf(chatList.get(chat.name)), 1);
      }
      let possibleConv = new PossibleChat(chat);
      let pos = this._getPositionToInsert(possibleConv, this._convs);
      this._convs.splice(pos, 0, possibleConv);
      chatList.set(chat.name, possibleConv);
    }
    if (this._pendingChats.length)
      executeSoon(this._addPendingChats.bind(this));
    else
      delete this._addingPendingChats;
    let now = Date.now();
    if ((!this._accountsRequestingRoomInfo.size && !this._pendingChats.length) ||
        now - this._lastUpdateNotification > 500) {
      this._notifyObservers("updated");
      this._lastUpdateNotification = now;
    }
  },

  _removeChatsForAccount: function(aAccId) {
    if (!this._chatsByAccountIdAndName.has(aAccId))
      return;
    // Keep only convs that either aren't chats or have a different account id.
    this._convs = this._convs.filter(function(c)
      c.source != "chat" || c.accountId != aAccId);
    this._chatsByAccountIdAndName.delete(aAccId);
    this._pendingChats = this._pendingChats.filter(function(c) c.accountId != aAccId);
  },

  _getPositionToInsert: function(aPossibleConversation, aArrayToInsert) {
    let end = aArrayToInsert.length;
    // Avoid the binary search loop if aArrayToInsert was already sorted.
    if (end == 0 ||
        this._sortComparator(aPossibleConversation, aArrayToInsert[end - 1]) >= 0)
      return end;
    let start = 0;
    while (start < end) {
      let middle = Math.floor((start + end) / 2);
      if (this._sortComparator(aPossibleConversation, aArrayToInsert[middle]) < 0)
        end = middle;
      else
        start = middle + 1;
    }
    return end;
  },

  _sortComparator: function(aPossibleConvA, aPossibleConvB) {
    let scoreA = aPossibleConvA.computedScore;
    let scoreB = aPossibleConvB.computedScore;
    // We want conversations with stats (both contacts and chats) to appear first,
    // followed by contacts with no stats, and finally chats with no stats.
    // Conversations with stats have a positive score.
    // Contacts with no stats get a 0, and chats get -1.
    let sign = function(x) x > 0 ? 1 : x < 0 ? -1 : 0;
    return sign(scoreB) - sign(scoreA) ||
      scoreB - scoreA ||
      aPossibleConvB.statusType - aPossibleConvA.statusType ||
      aPossibleConvA.lowerCaseName.localeCompare(aPossibleConvB.lowerCaseName);
  },

  _repositionConvsWithUpdatedStats: function() {
    for (let conv of this._convsWithUpdatedStats) {
      let currentPos = this._convs.indexOf(conv);
      // If the conv is no longer in the list (perhaps the contact was removed),
      // don't try to reposition it.
      if (currentPos == -1)
        continue;
      this._convs.splice(currentPos, 1);
      let newPos = this._getPositionToInsert(conv, this._convs);
      this._convs.splice(newPos, 0, conv);
    }
    this._convsWithUpdatedStats.clear();
  },

  getFilteredConvs: function(aFilterStr) {
    this._repositionConvsWithUpdatedStats();

    // Duplicate this._convs to avoid modifying it while adding existing convs.
    let filteredConvs = this._convs.slice(0);
    let existingConvs = Services.conversations.getUIConversations().map(
                          function(uiConv) new ExistingConversation(uiConv));
    for (let existingConv of existingConvs) {
      let uiConv = existingConv.uiConv;
      if (existingConv.isChat) {
        let chatList = this._chatsByAccountIdAndName.get(uiConv.account.id);
        if (chatList) {
          let chat = chatList.get(uiConv.name);
          if (chat)
            filteredConvs.splice(filteredConvs.indexOf(chat), 1);
        }
      }
      else {
        let contact = uiConv.contact;
        if (contact && this._contactsById.has(contact.id)) {
          filteredConvs.splice(
            filteredConvs.indexOf(this._contactsById.get(contact.id)), 1);
        }
      }
      let pos = this._getPositionToInsert(existingConv, filteredConvs);
      filteredConvs.splice(pos, 0, existingConv);
    }
    if (aFilterStr) {
      let searchWords = aFilterStr.toLowerCase().split(/\s+/);
      filteredConvs = filteredConvs.filter(function(c) {
        let words = c.lowerCaseName.split(/\s+/);
        return searchWords.every(function(s) {
          return words.some(function(word) {
            if (word.startsWith(s))
              return true;
            if (word.length && "#&+!@_*".indexOf(word[0]) != -1 &&
                word.substring(1).startsWith(s))
              return true;
            return false;
          });
        });
      });
    }
    return new nsSimpleEnumerator(filteredConvs);
  },

  _cacheAllStats: function() {
    let encoder = new TextEncoder();
    let objToWrite = {version: gStatsCacheVersion, stats: gStatsByConvId};
    OS.File.writeAtomic(this._statsCacheFilePath,
                        encoder.encode(JSON.stringify(objToWrite)),
                        {tmpPath: this._statsCacheFilePath + ".tmp"});
    if (this._statsCacheUpdateTimer) {
      clearTimeout(this._statsCacheUpdateTimer);
      delete this._statsCacheUpdateTimer;
    }
  },

  _requestRoomInfo: function() {
    let accounts = Services.accounts.getAccounts();
    while (accounts.hasMoreElements()) {
      let acc = accounts.getNext();
      let id = acc.id;
      if (acc.connected && acc.canJoinChat && (!this._chatsByAccountIdAndName.has(id) ||
          acc.prplAccount.isRoomInfoStale)) {
        // Discard any chat room data we already have.
        this._removeChatsForAccount(id);
        try {
          acc.prplAccount.requestRoomInfo(function(aRoomInfo, aPrplAccount, aCompleted) {
            if (aCompleted)
              this._accountsRequestingRoomInfo.delete(acc.id);
            this._pendingChats = this._pendingChats.concat(aRoomInfo);
            if (this._addingPendingChats)
              return;
            this._addingPendingChats = true;
            executeSoon(this._addPendingChats.bind(this));
          }.bind(this));
          this._accountsRequestingRoomInfo.add(acc.id);
        } catch(e) {
          if (e.result != Cr.NS_ERROR_NOT_IMPLEMENTED)
            Cu.reportError(e);
          continue;
        }
      }
    }
  },

  addObserver: function(aObserver) {
    if (this._observers.indexOf(aObserver) != -1)
      return;
    this._observers.push(aObserver);

    this._repositionConvsWithUpdatedStats();

    // We request chat lists from accounts when adding new observers.
    this._requestRoomInfo();
  },

  removeObserver: function(aObserver) {
    this._observers = this._observers.filter(function(o) o !== aObserver);
  },

  _notifyObservers: function(aTopic) {
    for each (let observer in this._observers) {
      if ("observe" in observer) // Avoid failing on destructed XBL bindings.
        observer.observe(this, "stats-service-" + aTopic);
    }
  },

  // Maps prplConversation ids to their ConversationStats objects.
  _statsByPrplConvId: new Map(),
  // Maps prplConversation ids to the corresponding PossibleConversations.
  _convsByPrplConvId: new Map(),
  // These will be repositioned to reflect their new scores when a newtab is opened.
  _convsWithUpdatedStats: new Set(),
  observe: function(aSubject, aTopic, aData) {
    if (aTopic == "profile-after-change")
      Services.obs.addObserver(this, "prpl-init", false);
    else if (aTopic == "prpl-init") {
      executeSoon(this._init.bind(this));
      Services.obs.removeObserver(this, "prpl-init");
    }
    else if (aTopic == "prpl-quit") {
      // Update the stats cache only if there was already an update scheduled.
      if (this._statsCacheUpdateTimer)
        this._cacheAllStats();
    }
    else if (aTopic == "new-text") {
      if (aSubject.system) // We don't care about system messages.
        return;

      let conv = aSubject.conversation;
      let stats = this._statsByPrplConvId.get(conv.id);
      aSubject.outgoing ? ++stats.outgoingCount : ++stats.incomingCount;
      stats.lastDate = Date.now();
      // Ensure the score is recomputed next time it's used.
      delete stats._computedScore;

      let possibleConv = this._convsByPrplConvId.get(conv.id);
      if (possibleConv) {
        if (possibleConv.source == "contact" && gStatsByContactId)
          delete gStatsByContactId[possibleConv._contactId];
        this._convsWithUpdatedStats.add(possibleConv);
      }

      // Schedule a cache update in 10 minutes.
      if (!this._statsCacheUpdateTimer) {
        this._statsCacheUpdateTimer =
          setTimeout(this._cacheAllStats.bind(this), 600000);
      }
    }
    else if (aTopic == "new-conversation") {
      let conv = aSubject;
      let id = getConversationId(conv.account.protocol.normalizedName,
                                 conv.account.name, conv.normalizedName, conv.isChat);
      if (!(id in gStatsByConvId))
        gStatsByConvId[id] = new ConversationStats(id);
      this._statsByPrplConvId.set(conv.id, gStatsByConvId[id]);

      let possibleConv = null;
      if (!conv.isChat) {
        // First .buddy is an imIAccountBuddy, second one is an imIBuddy.
        let contact = conv.buddy.buddy.contact;
        if (contact)
          possibleConv = this._contactsById.get(contact.id);
      }
      else {
        let chatList = this._chatsByAccountIdAndName.get(conv.account.id);
        if (chatList && chatList.has(conv.normalizedName))
          possibleConv = chatList.get(conv.name);
      }
      this._convsByPrplConvId.set(conv.id, possibleConv);
    }
    else if (aTopic == "conversation-closed")
      this._statsByPrplConvId.delete(aSubject.id);
    if (kNotificationsToObserve.indexOf(aTopic) == -1)
      return;
    if (aTopic == "contact-no-longer-dummy") {
      // Contact ID changed. aData is the old ID.
      let id = aSubject.id;
      let oldId = parseInt(aData, 10);
      this._contactsById.set(id, this._contactsById.get(oldId));
      this._contactsById.delete(oldId);
      this._contactsById.get(id)._contactId = id;
      return;
    }
    else if (aTopic == "contact-added")
      this._addContact(aSubject);
    else if (aTopic == "contact-removed")
      this._removeContact(aSubject.id);
    else if (aTopic.startsWith("contact")) {
      // A change in the contact's status or display name may cause the
      // order to change, so we simply remove and re-add it.
      this._removeContact(aSubject.id);
      this._addContact(aSubject);
    }
    else if (aTopic == "account-connected" &&
             this._observers.length) {
      // Ensure the existing newtabs have roomInfo for this account.
      this._requestRoomInfo();
    }
    else if (aTopic == "account-disconnected") {
      let id = aSubject.id;
      this._accountsRequestingRoomInfo.delete(id);
      this._removeChatsForAccount(id);
    }
    this._notifyObservers("updated");
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.ibIConvStatsService]),
  classDescription: "ConvStatsService",
  classID: Components.ID("{1d9be575-87a4-4f2f-b414-c67a560f29fd}"),
  contractID: "@instantbird.org/conv-stats-service;1"
};

function getConversationId(aProtocolId, aAccount, aName, aIsChat) {
  let id = [aProtocolId, aAccount, aName].join("/");
  if (aIsChat)
    id += ".chat";
  return id;
}

function ConversationStats(aConvId = "", aLastDate = 0,
                           aIncomingCount = 0, aOutgoingCount = 0) {
  this.id = aConvId;
  this.lastDate = aLastDate;
  this.incomingCount = aIncomingCount;
  this.outgoingCount = aOutgoingCount;
}
ConversationStats.prototype = {
  id: "",
  lastDate: 0,
  ONE_DAY: 24 * 60 * 60 * 1000,
  get daysBefore() (Date.now() - this.lastDate) / this.ONE_DAY,
  get msgCount() this.incomingCount + this.outgoingCount,
  incomingCount: 0,
  outgoingCount: 0,
  get frequencyMultiplier()
    this.outgoingCount / (this.incomingCount || 1),
  get recencyMultiplier() {
    let daysBefore = this.daysBefore;
    if (daysBefore < 4)
      return 1;
    if (daysBefore < 14)
      return 0.7;
    if (daysBefore < 31)
      return 0.5;
    if (daysBefore < 90)
      return 0.3;
    return 0.1;
  },
  get computedScore() {
    return this._computedScore || (this._computedScore =
      this.msgCount * this.frequencyMultiplier * this.recencyMultiplier);
  },
  mergeWith: function(aOtherStats) {
    let stats = new ConversationStats();
    stats.lastDate = Math.max(this.lastDate, aOtherStats.lastDate);
    stats.incomingCount = this.incomingCount + aOtherStats.incomingCount;
    stats.outgoingCount = this.outgoingCount + aOtherStats.outgoingCount;
    return stats;
  }
}

let PossibleConversation = {
  get displayName() this._displayName,
  get lowerCaseName()
    this._lowerCaseName || (this._lowerCaseName = this._displayName.toLowerCase()),
  _isChat: false, // False by default. Extensions should override this.
  get isChat() this._isChat,
  get statusType() this._statusType,
  get statusText() this._statusText,
  get infoText() this._infoText,
  get buddyIconFilename() this._buddyIconFilename,
  QueryInterface: XPCOMUtils.generateQI([Ci.ibIPossibleConversation])
};

function PossibleConvFromContact(aContact) {
  this._displayName = aContact.displayName;
  this._statusType = aContact.statusType;
  this._statusText = aContact.statusText;
  let buddy = aContact.preferredBuddy;
  this._contactId = aContact.id;
  this.id = getConversationId(buddy.protocol.normalizedName,
                              buddy.preferredAccountBuddy.account.name,
                              buddy.normalizedName, false);
}
PossibleConvFromContact.prototype = {
  __proto__: PossibleConversation,
  get statusText() this._statusText,
  get source() "contact",
  get buddyIds() {
    let buddies = this.contact.getBuddies();
    let ids = [];
    for (let buddy of buddies) {
      ids.push(getConversationId(buddy.protocol.normalizedName,
                                 buddy.preferredAccountBuddy.account.name,
                                 buddy.normalizedName, false));
    }
    return ids;
  },
  get lowerCaseName() {
    if (!this._lowerCaseName) {
      let buddies = this.contact.getBuddies();
      let names = [b.displayName for (b of buddies)].join(" ");
      this._lowerCaseName = names.toLowerCase();
    }
    return this._lowerCaseName;
  },
  get buddyIconFilename() this.contact.buddyIconFilename,
  get infoText() {
    let tagNames = this.contact.getTags().map(function(aTag) aTag.name);
    tagNames.sort(function(a, b) a.toLowerCase().localeCompare(b.toLowerCase()));
    return tagNames.join(", ");
  },
  get contact() Services.contacts.getContactById(this._contactId),
  get account() this.contact.preferredBuddy.preferredAccountBuddy.account,
  get computedScore() {
    let id = this._contactId;
    if (gStatsByContactId && gStatsByContactId[id])
      return gStatsByContactId[id].computedScore;
    // Contacts may have multiple buddies attached to them, so we sum their
    // individual message counts before arriving at the final score.
    let stats = new ConversationStats();
    for (let id of this.buddyIds) {
      let buddyStats = gStatsByConvId[id];
      if (buddyStats)
        stats = stats.mergeWith(buddyStats);
    }
    if (gStatsByContactId)
      gStatsByContactId[id] = stats;
    let score = stats.computedScore;
    // We apply a negative bias if statusType / STATUS_AVAILABLE is less than 0.5
    // (i.e. our status is less than or equal to STATUS_MOBILE), and a positive
    // one otherwise.
    score *= 0.5 + this.statusType / Ci.imIStatusInfo.STATUS_AVAILABLE;
    if (!this.contact.canSendMessage)
      score *= 0.75;
    return score;
  },
  createConversation: function() this.contact.createConversation()
};

function PossibleChat(aRoomInfo) {
  this._roomInfo = aRoomInfo;
  let account = this.account;
  this.id = getConversationId(account.protocol.normalizedName,
                              account.name, this.displayName, true);
}
PossibleChat.prototype = {
  get isChat() true,
  get statusType() Ci.imIStatusInfo.STATUS_AVAILABLE,
  get buddyIconFilename() "",
  get displayName() this._roomInfo.name,
  get lowerCaseName()
    this._lowerCaseName || (this._lowerCaseName = this.displayName.toLowerCase()),
  get statusText() {
    return "(" + this._roomInfo.participantCount + ") " +
      (this._roomInfo.topic || _instantbird("noTopic"));
  },
  get infoText() this.account.normalizedName,
  get source() "chat",
  get accountId() this._roomInfo.accountId,
  get account() Services.accounts.getAccountById(this.accountId),
  createConversation: function()
    this.account.joinChat(this._roomInfo.chatRoomFieldValues),
  get computedScore() {
    let stats = gStatsByConvId[this.id];
    if (stats && stats.computedScore)
      return stats.computedScore;
    // Force chats without a score to the end of the list.
    return -1;
  },
  QueryInterface: XPCOMUtils.generateQI([Ci.ibIPossibleConversation])
};

function ExistingConversation(aUIConv) {
  this._convId = aUIConv.target.id;
  let account = aUIConv.account;
  this.id = getConversationId(account.protocol.normalizedName,
                              account.name, aUIConv.normalizedName,
                              aUIConv.isChat);
  this._displayName = aUIConv.title;
  this._isChat = aUIConv.isChat;
  if (aUIConv.isChat) {
    this._statusText = aUIConv.topic || _instantbird("noTopic");
    this._statusType = PossibleChat.prototype.statusType;
    this._buddyIconFilename = "";
  }
  else {
    let buddy = aUIConv.buddy;
    if (buddy) {
      this._statusType = buddy.statusType;
      this._statusText = buddy.statusText;
      this._buddyIconFilename = buddy.buddyIconFilename;
    }
    else {
      this._statusType = Ci.imIStatusInfo.STATUS_UNKNOWN;
      this._statusText = "";
      this._buddyIconFilename = "";
    }
  }
  this._infoText = _newtab("existingConv.infoText");
}
ExistingConversation.prototype = {
  __proto__: PossibleConversation,
  get source() "existing",
  get uiConv() {
    return Services.conversations.getUIConversation(Services.conversations
                   .getConversationById(this._convId));
  },
  get account() this.uiConv.account,
  get computedScore() {
    let stats = gStatsByConvId[this.id];
    if (!stats) {
      // Force chats without a score to the end of the list.
      return this.isChat ? -1 : 0;
    }
    let score = stats.computedScore;
    // Give existing chats a negative bias. It's unlikely the user wants to
    // reopen them.
    if (this.isChat)
      score *= 0.8;
    // We don't apply the status biasing that PossibleConvFromContact does because
    // existing conversations are not as likely to be reopened as an available
    // contact, but are more likely to be reopened than an offline contact.
    // Averaging this out eliminates the status bias.
    return score;
  },
  createConversation: function() this.uiConv.target
};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([ConvStatsService]);
