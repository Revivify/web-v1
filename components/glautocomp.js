/* ***** BEGIN LICENSE BLOCK *****
 *   Version: MPL 1.1/GPL 2.0/LGPL 2.1
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
 * The Original Code is Thunderbird Global Database.
 *
 * The Initial Developer of the Original Code is
 * Mozilla Messaging, Inc.
 * Portions created by the Initial Developer are Copyright (C) 2008
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Andrew Sutherland <asutherland@asutherland.org>
 *   Mark Banner <bugzilla@standard8.plus.com>
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

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

var LOG = null;

var Gloda = null;
var GlodaUtils = null;
var MultiSuffixTree = null;
var TagNoun = null;
var FreeTagNoun = null;

function ResultRowSingle(aItem, aCriteriaType, aCriteria, aExplicitNounID) {
  this.nounID = aExplicitNounID || aItem.NOUN_ID;
  this.nounDef = Gloda._nounIDToDef[this.nounID];
  this.criteriaType = aCriteriaType;
  this.criteria = aCriteria;
  this.item = aItem;
}
ResultRowSingle.prototype = {
  multi: false
};

function ResultRowMulti(aNounID, aCriteriaType, aCriteria, aQuery) {
  this.nounID = aNounID;
  this.nounDef = Gloda._nounIDToDef[aNounID];
  this.criteriaType = aCriteriaType;
  this.criteria = aCriteria;
  this.collection = aQuery.getCollection(this);
  this.renderer = null;
}
ResultRowMulti.prototype = {
  multi: true,
  onItemsAdded: function(aItems) {
    LOG.debug("RRM onItemsAdded: " + aItems.length + ": " + aItems);
    if (this.renderer) {
      LOG.debug("RRM rendering...");
      for each (let [iItem, item] in Iterator(aItems)) {
        LOG.debug("RRM ..." + item);
        this.renderer.renderItem(item);
      }
    }
  },
  onItemsModified: function(aItems) {
  },
  onItemsRemoved: function(aItems) {
  },
  onQueryCompleted: function() {
  }
}

function nsAutoCompleteGlodaResult(aListener, aCompleter, aString) {
  this.listener = aListener;
  this.completer = aCompleter;
  this.searchString = aString;
  this._results = [];
  this._pendingCount = 0;
  this._problem = false;
  
  this.wrappedJSObject = this;
}
nsAutoCompleteGlodaResult.prototype = {
  getObjectAt: function(aIndex) {
    return this._results[aIndex];
  },
  markPending: function ACGR_markPending(aCompleter) {
    this._pendingCount++;
  },
  markCompleted: function ACGR_markCompleted(aCompleter) {
    if (--this._pendingCount == 0) {
      LOG.debug("Notifying completion.");
      this.listener.onSearchResult(this.completer, this);
    }
  },
  addRows: function ACGR_addRows(aRows) {
    if (!aRows.length)
      return;
    LOG.debug("Adding " + aRows.length + " rows (" + this._pendingCount +
              " jobs still pending)");
    this._results.push.apply(this._results, aRows); 
    this.listener.onSearchResult(this.completer, this);
  },
  // ==== nsIAutoCompleteResult
  searchString: null,
  get searchResult() {
    if (this._problem)
      return Ci.nsIAutoCompleteResult.RESULT_FAILURE;
    if (this._results.length)
      return (!this._pendingCount) ? Ci.nsIAutoCompleteResult.RESULT_SUCCESS
                          : Ci.nsIAutoCompleteResult.RESULT_SUCCESS_ONGOING;
    else
      return (!this._pendingCount) ? Ci.nsIAutoCompleteResult.RESULT_NOMATCH
                          : Ci.nsIAutoCompleteResult.RESULT_NOMATCH_ONGOING;
  },
  defaultIndex: -1,
  errorDescription: null,
  get matchCount() {
    return (this._results === null) ? 0 : this._results.length;
  },
  // this is the lower text, (shows the url in firefox)
  // we try and show the contact's name here.
  getValueAt: function(aIndex) {
    let thing = this._results[aIndex];
    return thing.name || thing.value || thing.subject;
  },
  // rich uses this to be the "title".  it is the upper text
  // we try and show the identity here.
  getCommentAt: function(aIndex) {
    let thing = this._results[aIndex];
    if (thing.value) // identity
      return thing.contact.name;
    else
      return thing.name || thing.subject;
  },
  // rich uses this to be the "type"
  getStyleAt: function(aIndex) {
    let row = this._results[aIndex];
    if (row.multi)
      return "gloda-multi";
    else
      return "gloda-single-" + row.nounDef.name;
  },
  // rich uses this to be the icon
  getImageAt: function(aIndex) {
    let thing = this._results[aIndex];
    if (!thing.value)
      return null;

    let md5hash = GlodaUtils.md5HashString(thing.value);
    let gravURL = "http://www.gravatar.com/avatar/" + md5hash +
                                "?d=identicon&s=32&r=g";
    return gravURL;
  },
  removeValueAt: function() {},

  _stop: function() {
  },
};

const MAX_POPULAR_CONTACTS = 200;

/**
 * Complete contacts/identities based on name/email.  Instant phase is based on
 *  a suffix-tree built of popular contacts/identities.  Delayed phase relies
 *  on a LIKE search of all known contacts.
 */
function ContactIdentityCompleter() {
  // get all the contacts
  let contactQuery = Gloda.newQuery(Gloda.NOUN_CONTACT);
  contactQuery.orderBy("-popularity").limit(MAX_POPULAR_CONTACTS);
  this.contactCollection = contactQuery.getCollection(this, null);
}
ContactIdentityCompleter.prototype = {
  _popularitySorter: function(a, b){ return b.popularity - a.popularity; },
  complete: function ContactIdentityCompleter_complete(aResult, aString) {
    if (aString.length < 3)
      return false;

    let matches;
    if (this.suffixTree) {
      matches = this.suffixTree.findMatches(aString.toLowerCase());
      LOG.debug("CIC: Suffix Tree found " + matches.length + " matches.")
    }
    else
      matches = [];

    // let's filter out duplicates due to identity/contact double-hits by
    //  establishing a map based on the contact id for these guys.
    // let's also favor identities as we do it, because that gets us the
    //  most accurate gravat, potentially
    let contactToThing = {};
    for (let iMatch = 0; iMatch < matches.length; iMatch++) {
      let thing = matches[iMatch];
      if (thing.NOUN_ID == Gloda.NOUN_CONTACT && !(thing.id in contactToThing))
        contactToThing[thing.id] = thing;
      else if (thing.NOUN_ID == Gloda.NOUN_IDENTITY)
        contactToThing[thing.contactID] = thing;
    }
    // and since we can now map from contacts down to identities, map contacts
    //  to the first identity for them that we find...
    matches = [val.NOUN_ID == Gloda.NOUN_IDENTITY ? val : val.identities[0]
               for each ([iVal, val] in Iterator(contactToThing))];

    let rows = [new ResultRowSingle(match, "text", aResult.searchString)
                for each ([iMatch, match] in Iterator(matches))];
    aResult.addRows(rows);

    // - match against database contacts / identities
    let pending = {contactToThing: contactToThing, pendingCount: 2};
    
    LOG.debug("CIC: issuing contact LIKE query");
    let contactQuery = Gloda.newQuery(Gloda.NOUN_CONTACT);
    contactQuery.nameLike(contactQuery.WILD, aString, contactQuery.WILD);
    pending.contactColl = contactQuery.getCollection(this, aResult);

    LOG.debug("CIC: issuing identity LIKE query");
    let identityQuery = Gloda.newQuery(Gloda.NOUN_IDENTITY);
    identityQuery.kind("email").valueLike(identityQuery.WILD, aString,
        identityQuery.WILD);
    pending.identityColl = identityQuery.getCollection(this, aResult);
    
    aResult._contactCompleterPending = pending;

    return true;
  },
  onItemsAdded: function(aItems, aCollection) {
  },
  onItemsModified: function(aItems, aCollection) {
  },
  onItemsRemoved: function(aItems, aCollection) {
  },
  onQueryCompleted: function(aCollection) {
    // handle the initial setup case...
    if (aCollection.data == null) {
      LOG.debug("CIC: Initial query found " + aCollection.items.length);
      // cheat and explicitly add our own contact...
      if (!(Gloda.myContact.id in this.contactCollection._idMap))
        this.contactCollection._onItemsAdded([Gloda.myContact]);
        
      // the set of identities owned by the contacts is automatically loaded as part
      //  of the contact loading...
      // (but only if we actually have any contacts)
      this.identityCollection =
        this.contactCollection.subCollections[Gloda.NOUN_IDENTITY];

      let contactNames = [(c.name.replace(" ", "").toLowerCase() || "x") for each
                          ([, c] in Iterator(this.contactCollection.items))];
      // if we had no contacts, we will have no identity collection!
      let identityMails;
      if (this.identityCollection)
        identityMails = [i.value.toLowerCase() for each
                         ([, i] in Iterator(this.identityCollection.items))];

      this.suffixTree = new MultiSuffixTree(contactNames.concat(identityMails),
        this.contactCollection.items.concat(this.identityCollection.items));
      
      return;
    }
    
    LOG.debug("CIC: LIKE query found " + aCollection.items.length);
    
    // handle the completion case
    let result = aCollection.data;
    let pending = result._contactCompleterPending;
    
    if (--pending.pendingCount == 0) {
      let possibleDudes = [];
      
      let contactToThing = pending.contactToThing;
      
      let items;
      
      // check identities first because they are better than contacts in terms
      //  of display
      items = pending.identityColl.items;
      for (let iIdentity = 0; iIdentity < items.length; iIdentity++){
        let identity = items[iIdentity];
        if (!(identity.contactID in contactToThing)) {
          contactToThing[identity.contactID] = identity;
          possibleDudes.push(identity);
          // augment the identity with its contact's popularity
          identity.popularity = identity.contact.popularity;
        }
      }
      items = pending.contactColl.items;
      for (let iContact = 0; iContact < items.length; iContact++) {
        let contact = items[iContact];
        if (!(contact.id in contactToThing)) {
          contactToThing[contact.id] = contact;
          possibleDudes.push(contact.identities[0]);
        }
      }
      
      // sort in order of descending popularity
      possibleDudes.sort(this._popularitySorter);
      let rows = [new ResultRowSingle(dude, "text", result.searchString)
                  for each ([iDude, dude] in Iterator(possibleDudes))];
      result.addRows(rows);
      result.markCompleted(this);
      
      // the collections no longer care about the result, make it clear.
      delete pending.identityColl.data;
      delete pending.contactColl.data;
      // the result object no longer needs us or our data
      delete result._contactCompleterPending;
    }
    else {
      LOG.debug("ignoring... pending is still: " + pending.pendingCount);
    }
  }
};

/**
 * Complete tags that are used on contacts.
 */
function ContactTagCompleter() {
  FreeTagNoun.populateKnownFreeTags();
  this._buildSuffixTree();
  FreeTagNoun.addListener(this);
}
ContactTagCompleter.prototype = {
  _buildSuffixTree: function() {
    let tagNames = [], tags = [];
    for (let [tagName, tag] in Iterator(FreeTagNoun.knownFreeTags)) {
      tagNames.push(tagName.toLowerCase());
      tags.push(tag);
      LOG.debug("contact tag: " + tagName);
    }
    this._suffixTree = new MultiSuffixTree(tagNames, tags);
    this._suffixTreeDirty = false;
  },
  onFreeTagAdded: function(aTag) {
    this._suffixTreeDirty = true;
  },
  complete: function ContactTagCompleter_complete(aResult, aString) {
    // now is not the best time to do this; have onFreeTagAdded use a timer.
    if (this._suffixTreeDirty)
      this._buildSuffixTree();
    
    if (aString.length < 2)
      return false; // no async mechanism that will add new rows
    
    LOG.debug("Completing on contact tags...");
    
    tags = this._suffixTree.findMatches(aString.toLowerCase());
    let rows = [];
    for each (let [iTag, tag] in Iterator(tags)) {
      let query = Gloda.newQuery(Gloda.NOUN_CONTACT);
      LOG.debug("  checking for contact tag: " + tag.name);
      query.freeTags(tag);
      let resRow = new ResultRowMulti(Gloda.NOUN_CONTACT, "tag", tag.name,
                                      query);
      rows.push(resRow);
    }
    aResult.addRows(rows);
    
    return false; // no async mechanism that will add new rows
  }
};

/**
 * Complete tags that are used on messages
 */
function MessageTagCompleter() {
  this._buildSuffixTree();
}
MessageTagCompleter.prototype = {
  _buildSuffixTree: function MessageTagCompleter__buildSufficeTree() {
    let tagNames = [], tags = [];
    let tagArray = TagNoun.getAllTags();
    for (let iTag = 0; iTag < tagArray.length; iTag++) {
      let tag = tagArray[iTag];
      tagNames.push(tag.tag.toLowerCase());
      tags.push(tag);
      LOG.debug("message tag: " + tag.tag);
    }
    this._suffixTree = new MultiSuffixTree(tagNames, tags);
    this._suffixTreeDirty = false;
  },
  complete: function MessageTagCompleter_complete(aResult, aString) {
    if (aString.length < 2)
      return false;
    
    LOG.debug("Completing on message tags...");
    
    tags = this._suffixTree.findMatches(aString.toLowerCase());
    let rows = [];
    for each (let [, tag] in Iterator(tags)) {
      LOG.debug(" found message tag: " + tag.tag);
      let resRow = new ResultRowSingle(tag, "tag", tag.tag, TagNoun.id);
      rows.push(resRow);
    }
    aResult.addRows(rows);
    
    return false; // no async mechanism that will add new rows
  }
};

function nsAutoCompleteGloda() {
  this.wrappedJSObject = this;

  // set up our awesome globals!
  if (Gloda === null) {
    let loadNS = {};

    Cu.import("resource://gloda/modules/public.js", loadNS);
    Gloda = loadNS.Gloda;

    Cu.import("resource://gloda/modules/utils.js", loadNS);
    GlodaUtils = loadNS.GlodaUtils;
    Cu.import("resource://gloda/modules/suffixtree.js", loadNS);
    MultiSuffixTree = loadNS.MultiSuffixTree;
    Cu.import("resource://gloda/modules/noun_tag.js", loadNS);
    TagNoun = loadNS.TagNoun;
    Cu.import("resource://gloda/modules/noun_freetag.js", loadNS);
    FreeTagNoun = loadNS.FreeTagNoun;

    Cu.import("resource://gloda/modules/log4moz.js", loadNS);
    LOG = loadNS["Log4Moz"].Service.getLogger("gloda.autocomp");
  }

  LOG.debug("initializing completers");

  this.completers = [];
  
  this.curResult = null;

dump("init CIC\n");
  LOG.debug("initializing ContactIdentityCompleter");
  try {
  this.completers.push(new ContactIdentityCompleter());
  } catch (ex) {dump("CICEX: " + ex.fileName + ":" + ex.lineNumber + ": " + ex);}
dump("init CTC\n");
  LOG.debug("initializing ContactTagCompleter");
  this.completers.push(new ContactTagCompleter());
dump("init MTC\n");
  LOG.debug("initializing MessageTagCompleter");
  try {
  this.completers.push(new MessageTagCompleter());
  } catch (ex) {dump("MTCEX: " + ex.fileName + ":" + ex.lineNumber + ": " + ex);}
  
  LOG.debug("initialized completers");
}

nsAutoCompleteGloda.prototype = {
  classDescription: "AutoCompleteGloda",
  contractID: "@mozilla.org/autocomplete/search;1?name=gloda",
  classID: Components.ID("{3bbe4d77-3f70-4252-9500-bc00c26f476c}"),
  QueryInterface: XPCOMUtils.generateQI([
      Components.interfaces.nsIAutoCompleteSearch]),

  startSearch: function(aString, aParam, aResult, aListener) {
    let result = new nsAutoCompleteGlodaResult(aListener, this, aString);
    // save this for hacky access to the search.  I somewhat suspect we simply
    //  should not be using the formal autocomplete mechanism at all.
    this.curResult = result;
    
    for each (let [iCompleter, completer] in Iterator(this.completers)) {
      // they will return true if they have something pending.
      if (completer.complete(result, aString))
        result.markPending(completer);
    }
    
    aListener.onSearchResult(this, result);
  },

  stopSearch: function() {
  },
};

function NSGetModule(compMgr, fileSpec) {
  return XPCOMUtils.generateModule([nsAutoCompleteGloda]);
}
