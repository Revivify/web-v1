/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 *
 * ***** BEGIN LICENSE BLOCK *****
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
 * The Original Code is the mozilla.org LDAP XPCOM SDK.
 *
 * The Initial Developer of the Original Code is
 * Netscape Communications Corporation.
 * Portions created by the Initial Developer are Copyright (C) 2000
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Dan Mosedale <dmose@mozilla.org>
 *   Leif Hedstrom <leif@netscape.com>
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

#ifndef _nsLDAPConnection_h_
#define _nsLDAPConnection_h_

#include "nsILDAPConnection.h"
#include "ldap.h"
#include "nsStringGlue.h"
#include "nsIThread.h"
#include "nsIRunnable.h"
#include "nsCOMPtr.h"
#include "nsILDAPMessageListener.h"
#include "nsInterfaceHashtable.h"
#include "nspr.h"
#include "nsWeakReference.h"
#include "nsWeakPtr.h"
#include "nsIDNSListener.h"
#include "nsICancelable.h"
#include "nsIRequest.h"
#include "nsCOMArray.h"
#include "nsIObserver.h"
#include "nsAutoPtr.h"

// 0d871e30-1dd2-11b2-8ea9-831778c78e93
//
#define NS_LDAPCONNECTION_CID \
{ 0x0d871e30, 0x1dd2, 0x11b2, \
 { 0x8e, 0xa9, 0x83, 0x17, 0x78, 0xc7, 0x8e, 0x93 }}

class nsLDAPConnection : public nsILDAPConnection,
                         public nsSupportsWeakReference,
                         public nsIDNSListener,
                         public nsIObserver

{
    friend class nsLDAPOperation;
    friend class nsLDAPMessage;
    friend class nsLDAPConnectionRunnable;

  public:
    NS_DECL_ISUPPORTS
    NS_DECL_NSILDAPCONNECTION
    NS_DECL_NSIDNSLISTENER
    NS_DECL_NSIOBSERVER

    // constructor & destructor
    //
    nsLDAPConnection();
    virtual ~nsLDAPConnection();

  protected:
    // invoke the callback associated with a given message, and possibly
    // delete it from the connection queue
    //
    nsresult InvokeMessageCallback(LDAPMessage *aMsgHandle,
                                   nsILDAPMessage *aMsg,
                                   PRInt32 aOperation,
                                   bool aRemoveOpFromConnQ);
    /**
     * Add an nsILDAPOperation to the list of operations pending on
     * this connection.  This is mainly intended for use by the
     * nsLDAPOperation code.  Used so that the thread waiting on messages
     * for this connection has an operation to callback to.
     *
     * @param aOperation                    operation to add
     * @exception NS_ERROR_ILLEGAL_VALUE    aOperation was NULL
     * @exception NS_ERROR_UNEXPECTED       this operation's msgId was not
     *                                      unique to this connection
     * @exception NS_ERROR_OUT_OF_MEMORY    out of memory
     */
  nsresult AddPendingOperation(PRUint32 aOperationID, nsILDAPOperation *aOperation);

    /**
     * Remove an nsILDAPOperation from the list of operations pending on this
     * connection.  Mainly intended for use by the nsLDAPOperation code.
     *
     * @param aOperation        operation to add
     * @exception NS_ERROR_INVALID_POINTER  aOperation was NULL
     * @exception NS_ERROR_OUT_OF_MEMORY    out of memory
     * @exception NS_ERROR_FAILURE          could not delete the operation
     */
    nsresult RemovePendingOperation(PRUint32 aOperationID);

    void Close();                       // close the connection
    LDAP *mConnectionHandle;            // the LDAP C SDK's connection object
    nsCString mBindName;                // who to bind as
    nsCOMPtr<nsIThread> mThread;        // thread which marshals results

    nsInterfaceHashtableMT<nsUint32HashKey, nsILDAPOperation> mPendingOperations;

    PRInt32 mPort;                      // The LDAP port we're binding to
    bool mSSL;                        // the options
    PRUint32 mVersion;                  // LDAP protocol version

    nsCString mResolvedIP;              // Preresolved list of host IPs
    nsCOMPtr<nsILDAPMessageListener> mInitListener; // Init callback
    nsCOMPtr<nsICancelable> mDNSRequest;   // The "active" DNS request
    nsCString               mDNSHost;   // The hostname being resolved
    nsCOMPtr<nsISupports> mClosure;     // private parameter (anything caller desires)
};

class nsLDAPConnectionRunnable : public nsIRunnable
{
  friend class nsLDAPConnection;
  friend class nsLDAPMessage;

public:
  nsLDAPConnectionRunnable(PRInt32 aOperationID,
                           nsILDAPOperation *aOperation,
                           nsLDAPConnection *aConnection);
  virtual ~nsLDAPConnectionRunnable();

  NS_DECL_ISUPPORTS
  NS_DECL_NSIRUNNABLE

  PRInt32 mOperationID;
  nsRefPtr<nsLDAPConnection> mConnection;
};

#endif // _nsLDAPConnection_h_
