use crate::xpcom::XpCom;
use nserror::{
    nsresult, NS_ERROR_ALREADY_OPENED, NS_ERROR_CANNOT_CONVERT_DATA, NS_ERROR_FAILURE,
    NS_ERROR_ILLEGAL_VALUE, NS_ERROR_INVALID_ARG, NS_ERROR_NOT_AVAILABLE,
    NS_ERROR_OBJECT_IS_IMMUTABLE, NS_OK,
};
use nsstring::{nsACString, nsCString};
use thin_vec::ThinVec;
use xpcom::{
    interfaces::{nsIObserver, nsISupports, nsITimer, ILoxPromise, ILoxService, ILoxServiceHelper},
    RefPtr,
};

use lox_library::{cred::Invitation, proto::open_invite, scalar_u32};
use lox_utils::{validate, Invite, LoxCredential, PubKeys};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::{c_char, CStr},
    net::Ipv6Addr,
    ptr::null,
};
use uuid::Uuid;

fn json_from_string(data: &nsACString) -> Result<JsonValue, nsresult> {
    serde_json::from_slice(&data[..]).map_err(|_| NS_ERROR_CANNOT_CONVERT_DATA)
}

/**
 * Use this function to pass a promise over XPCOM call boundaries.
 * The pointer must be used, or this will be a memory leak!
 */
#[must_use]
fn promise_ptr(promise: RefPtr<ILoxPromise>) -> *const ILoxPromise {
    let mut ptr: *const ILoxPromise = null();
    promise.forget(&mut ptr);
    ptr
}

/**
 * An implementation of ILoxPromise to be used from Rust.
 * It can be chained to another ILoxPromise, which can be implemented either in
 * Rust or in JavaScript.
 */
#[xpcom(implement(ILoxPromise), atomic)]
struct LoxPromiseRust {
    resolve_handler: RefCell<Option<Box<dyn FnOnce(&nsACString) -> ()>>>,
    reject_handler: RefCell<Option<Box<dyn FnOnce(&nsACString) -> ()>>>,
}

impl LoxPromiseRust {
    /**
     * Create a new promise with an error handler.
     */
    fn new(
        resolve: Box<dyn FnOnce(&nsACString) -> ()>,
        reject: Box<dyn FnOnce(&nsACString) -> ()>,
    ) -> RefPtr<LoxPromiseRust> {
        LoxPromiseRust::allocate(InitLoxPromiseRust {
            resolve_handler: RefCell::new(Some(resolve)),
            reject_handler: RefCell::new(Some(reject)),
        })
    }

    /**
     * Create a promise that propagates the error to another promise.
     * When successful, though, it is responsibility of the owner to resolve the
     * promise that was passed as an argument to this one.
     */
    fn new_chained(
        resolve: Box<dyn FnOnce(&nsACString) -> ()>,
        promise: RefPtr<ILoxPromise>,
    ) -> RefPtr<LoxPromiseRust> {
        LoxPromiseRust::allocate(InitLoxPromiseRust {
            resolve_handler: RefCell::new(Some(resolve)),
            reject_handler: RefCell::new(Some(Box::new(move |error: &nsACString| unsafe {
                promise.Reject(error);
            }))),
        })
    }

    xpcom_method!(resolve => Resolve(response: *const nsACString));
    unsafe fn resolve(&self, response: &nsACString) -> Result<(), nsresult> {
        Self::consume_and_call(&self.resolve_handler, response)
    }

    xpcom_method!(reject => Reject(error: *const nsACString));
    unsafe fn reject(&self, error: &nsACString) -> Result<(), nsresult> {
        Self::consume_and_call(&self.reject_handler, error)
    }

    /**
     * Cast this promise to a generic ILoxPromise.
     */
    fn as_promise(&self) -> RefPtr<ILoxPromise> {
        RefPtr::new(self.coerce::<ILoxPromise>())
    }

    fn consume_and_call(
        cell: &RefCell<Option<Box<dyn FnOnce(&nsACString) -> ()>>>,
        s: &nsACString,
    ) -> Result<(), nsresult> {
        match cell.try_borrow_mut().map_err(|_| NS_ERROR_FAILURE)?.take() {
            Some(f) => {
                (f)(s);
                Ok(())
            }
            None => Err(NS_ERROR_NOT_AVAILABLE),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct LoxData {
    credentials: HashMap<String, LoxCredential>,
    // TODO: Check if this is the right type.
    invitations: Vec<Invitation>,
    pub_keys: Option<PubKeys>,
}

#[xpcom(implement(ILoxService, nsIObserver), atomic)]
struct LoxService {
    // xpcom stuff usually is non-mut, so use RefCell for now...
    // Maybe a better idea is to have a single RefCell for a single struct,
    // which we use for actually implementing stuff.
    // It might even be a Rc<RefCell> if we want to implement the timer observer
    // separately.
    helper: RefCell<Option<RefPtr<ILoxServiceHelper>>>,
    timer: RefCell<Option<RefPtr<nsITimer>>>,
    data: RefCell<LoxData>,
}

impl LoxService {
    fn new() -> RefPtr<LoxService> {
        LoxService::allocate(InitLoxService {
            helper: RefCell::new(None),
            timer: RefCell::new(None),
            data: RefCell::new(LoxData::default()),
        })
    }

    xpcom_method!(observe => Observe(_subject: *const nsISupports, topic: *const c_char, _data: *const u16));
    unsafe fn observe(
        &self,
        _subject: Option<&nsISupports>,
        topic: *const c_char,
        _data: *const u16,
    ) -> Result<(), nsresult> {
        let topic = CStr::from_ptr(topic);
        if topic == cstr!("timer-callback") {
            return self.make_request(
                "timer-thing",
                "",
                LoxPromiseRust::new(
                    Box::new(|val| {
                        println!("Got a value from JS! {}", val);
                    }),
                    Box::new(|err| {
                        println!("Got an error from JS {}", err);
                    }),
                )
                .as_promise(),
            );
        }
        Ok(())
    }

    xpcom_method!(initialize => Initialize(helper: *const ILoxServiceHelper, data: *const nsACString));
    fn initialize(&self, helper: &ILoxServiceHelper, data: &nsACString) -> Result<(), nsresult> {
        let helper = helper
            .query_interface::<ILoxServiceHelper>()
            .ok_or(NS_ERROR_FAILURE)?;
        let mut h = self
            .helper
            .try_borrow_mut()
            .map_err(|_| NS_ERROR_OBJECT_IS_IMMUTABLE)?;

        let data: JsonValue = json_from_string(data)?;
        // TODO: Store this data to a member (and deserialize to the proper type...).

        // Be sure the data has been deserialized before saving the helper.
        *h = Some(helper);

        // We do not care that much of this timer for now, so do not do anything
        // if its creation fails.
        match xpcom::create_instance::<nsITimer>(cstr!("@mozilla.org/timer;1")) {
            Some(timer) => {
                let mut observer: *const nsIObserver = null();
                RefPtr::new(self.coerce::<nsIObserver>()).forget(&mut observer);
                unsafe { timer.Init(observer, 2000, 0) };
                // FIXME: This might panic!
                self.timer.replace(Some(timer));
            }
            None => println!("Could not create the timer!"),
        };

        Ok(())
    }

    xpcom_method!(uninitialize => Uninitialize());
    fn uninitialize(&self) -> Result<(), nsresult> {
        let rv = match self.helper.try_borrow_mut() {
            Ok(mut runner) => {
                if let Some(r) = runner.as_ref() {
                    // TODO: Actually serialize the data.
                    let data = nsCString::new();
                    unsafe { r.Store(&*data) };
                }
                *runner = None;
                Ok(())
            }
            Err(_) => Err(NS_ERROR_NOT_AVAILABLE),
        };
        if let Ok(mut timer) = self.timer.try_borrow_mut() {
            *timer = None;
        }
        rv
    }

    xpcom_method!(get_bridges => GetBridges(lox_id: *const nsACString) -> ThinVec<nsCString>);
    fn get_bridges(&self, lox_id: &nsACString) -> Result<ThinVec<nsCString>, nsresult> {
        self.read(|data: &LoxData| {
            let cred = data
                .credentials
                .get(lox_id.to_utf8().as_ref())
                .ok_or(NS_ERROR_NOT_AVAILABLE)?;
            Ok(cred.bridgelines.as_ref().map_or(ThinVec::new(), |lines| {
                lines
                    .iter()
                    .map(|line| {
                        let ip = Ipv6Addr::from(line.addr).to_canonical().to_string();
                        // TODO: Wait for the lox#46 to be fixed for the proper info.
                        nsCString::from(format!(
                            "{}:{} {}",
                            ip,
                            line.port,
                            nsCString::from(&line.info[..]).to_utf8()
                        ))
                    })
                    .collect::<ThinVec<nsCString>>()
            }))
        })
    }

    xpcom_method!(validate_invitation => ValidateInvitation(invitation: *const nsACString) -> bool);
    fn validate_invitation(&self, invitation: &nsACString) -> Result<bool, nsresult> {
        if serde_json::from_slice::<Invitation>(&invitation[..]).is_ok() {
            return Ok(true);
        }
        // FIXME: Why check also this? We could return false without errors,
        // instead of forcing the caller to catch.
        if serde_json::from_slice::<Invite>(&invitation[..]).is_ok() {
            return Ok(false);
        }
        Err(NS_ERROR_INVALID_ARG)
    }

    xpcom_method!(get_invites => GetInvites() -> ThinVec<nsCString>);
    fn get_invites(&self) -> Result<ThinVec<nsCString>, nsresult> {
        self.read(|data| {
            data.invitations
                .iter()
                .map(|inv| match serde_json::to_string(inv) {
                    Ok(v) => Ok(nsCString::from(v)),
                    Err(_) => Err(NS_ERROR_FAILURE),
                })
                .collect::<Result<ThinVec<nsCString>, nsresult>>()
        })
    }

    xpcom_method!(get_num_invites => GetNumInvites() -> u32);
    fn get_num_invites(&self) -> Result<u32, nsresult> {
        self.read(|data| {
            let num = data.invitations.len().try_into();
            num.map_err(|_| NS_ERROR_ILLEGAL_VALUE)
        })
    }

    xpcom_method!(get_remaining_invite_count => GetRemainingInviteCount(lox_id: *const nsACString) -> u32);
    fn get_remaining_invite_count(&self, lox_id: &nsACString) -> Result<u32, nsresult> {
        self.read(|data| {
            let cred = data
                .credentials
                .get(lox_id.to_utf8().as_ref())
                .ok_or(NS_ERROR_NOT_AVAILABLE)?;
            scalar_u32(&cred.lox_credential.invites_remaining).ok_or(NS_ERROR_ILLEGAL_VALUE)
        })
    }

    xpcom_method!(get_event_data => GetEventData() -> nsACString);
    fn get_event_data(&self) -> Result<nsCString, nsresult> {
        Ok(nsCString::from("[]"))
    }

    xpcom_method!(redeem_invite => RedeemInvite(invite: *const nsACString, promise: *const ILoxPromise));
    fn redeem_invite(&self, invite: &nsACString, promise: &ILoxPromise) -> Result<(), nsresult> {
        let self_ref = RefPtr::new(self);
        let promise_ref = RefPtr::new(promise);
        let invite: Invite =
            serde_json::from_value(json_from_string(invite)?).map_err(|_| NS_ERROR_INVALID_ARG)?;
        let token = validate(&invite.invite).map_err(|_| NS_ERROR_INVALID_ARG)?;
        let (request, state) = open_invite::request(&token);
        let request = serde_json::to_string(&request).map_err(|_| NS_ERROR_FAILURE)?;

        // TODO: Download the public keys

        self.make_request(
            "openreq",
            &request,
            LoxPromiseRust::new_chained(
                Box::new(
                    move |response_str| match serde_json::from_slice(&response_str[..]) {
                        Ok(response) => match self_ref.handle_new_credential(state, response) {
                            Ok(id) => {
                                let _ = self_ref.store();
                                let id = nsCString::from(id);
                                unsafe { promise_ref.Resolve(&*id) };
                            }
                            Err(e) => {
                                let e = nsCString::from(e);
                                unsafe { promise_ref.Reject(&*e) };
                            }
                        },
                        Err(e) => {
                            let e = nsCString::from(e.to_string());
                            unsafe { promise_ref.Reject(&*e) };
                        }
                    },
                ),
                RefPtr::new(promise),
            )
            .as_promise(),
        )
    }

    fn handle_new_credential(
        &self,
        state: open_invite::State,
        resp: open_invite::Response,
    ) -> Result<String, String> {
        let mut data = self.data.try_borrow_mut().map_err(|e| e.to_string())?;
        let pub_keys = data
            .pub_keys
            .as_ref()
            .ok_or(String::from("Public keys not available."))?;
        let (lox_credential, bridge_line) =
            open_invite::handle_response(state, resp, &pub_keys.lox_pub)
                .map_err(|e| e.to_string())?;
        let mut id = Uuid::new_v4().to_string();
        while data.credentials.contains_key(&id) {
            id = Uuid::new_v4().to_string();
        }
        data.credentials.insert(
            id.clone(),
            LoxCredential {
                lox_credential,
                bridgelines: Some(vec![bridge_line]),
                invitation: None,
            },
        );
        Ok(id)
    }

    xpcom_method!(generate_invite => GenerateInvite(lox_id: *const nsACString, promise: *const ILoxPromise));
    fn generate_invite(&self, lox_id: &nsACString, promise: &ILoxPromise) -> Result<(), nsresult> {
        let promise_ptr = RefPtr::new(promise);
        self.make_request(
            "pubkeys",
            "",
            LoxPromiseRust::new_chained(
                Box::new(move |val| {
                    // TODO: Actually do something with the value we received from the network.
                    unsafe { promise_ptr.Resolve(&*val) };
                }),
                RefPtr::new(promise),
            )
            .as_promise(),
        )
    }

    fn read<T, F: FnOnce(&LoxData) -> Result<T, nsresult>>(&self, f: F) -> Result<T, nsresult> {
        let data = self
            .data
            .try_borrow()
            .map_err(|_| NS_ERROR_ALREADY_OPENED)?;
        f(&data)
    }

    fn make_request(
        &self,
        procedure: &str,
        request: &str,
        promise: RefPtr<ILoxPromise>,
    ) -> Result<(), nsresult> {
        let procedure = nsCString::from(procedure);
        let request = nsCString::from(request);
        self.helper(move |h| {
            unsafe { h.RunRequest(&*procedure, &*request, promise_ptr(promise)) }.to_result()
        })
    }

    fn store(&self) -> Result<(), nsresult> {
        self.helper(|h| {
            self.read(move |data| {
                let data = serde_json::to_string(data).map_err(|_| NS_ERROR_FAILURE)?;
                let data = nsCString::from(data);
                unsafe { h.Store(&*data) }.to_result()
            })
        })
    }

    fn helper<F: FnOnce(RefPtr<ILoxServiceHelper>) -> Result<(), nsresult>>(
        &self,
        f: F,
    ) -> Result<(), nsresult> {
        let helper = self
            .helper
            .try_borrow()
            .map_err(|_| NS_ERROR_ALREADY_OPENED)?;
        let helper = helper.clone();
        let helper = helper.ok_or(NS_ERROR_NOT_AVAILABLE)?;
        f(helper)
    }
}

// See toolkit/components/extensions/storage/webext_storage_bridge/src/lib.rs.
#[no_mangle]
pub unsafe extern "C" fn NewLoxServiceImpl(result: *mut *const ILoxService) -> nsresult {
    let service = LoxService::new();
    RefPtr::new(service.coerce::<ILoxService>()).forget(&mut *result);
    NS_OK
}
