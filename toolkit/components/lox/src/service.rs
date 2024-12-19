use crate::xpcom::XpCom;
use nserror::{
    nsresult, NS_ERROR_ALREADY_OPENED, NS_ERROR_CANNOT_CONVERT_DATA, NS_ERROR_FAILURE,
    NS_ERROR_ILLEGAL_VALUE, NS_ERROR_INVALID_ARG, NS_ERROR_NOT_AVAILABLE,
    NS_ERROR_OBJECT_IS_IMMUTABLE, NS_OK,
};
use nsstring::{nsACString, nsCString};
use thin_vec::ThinVec;
use xpcom::{
    interfaces::{
        nsIObserver, nsISupports, nsITimer, ILoxCallback, ILoxRequestHandler, ILoxService,
        ILoxServiceHelper,
    },
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

#[xpcom(implement(ILoxRequestHandler), atomic)]
struct LoxRequestHandler {
    handler: RefCell<Option<Box<dyn FnOnce(&nsACString) -> Result<(), nsresult>>>>,
    callback: RefPtr<ILoxCallback>,
}

impl LoxRequestHandler {
    fn new(
        handler: Box<dyn FnOnce(&nsACString) -> Result<(), nsresult>>,
        callback: RefPtr<ILoxCallback>,
    ) -> RefPtr<LoxRequestHandler> {
        LoxRequestHandler::allocate(InitLoxRequestHandler {
            handler: RefCell::new(Some(handler)),
            callback,
        })
    }

    fn leak(&self) -> *const ILoxRequestHandler {
        let mut ptr = null();
        RefPtr::new(self.coerce::<ILoxRequestHandler>()).forget(&mut ptr);
        ptr
    }

    xpcom_method!(handle => Handle(status: u32, response: *const nsACString));
    fn handle(&self, status: u32, response: &nsACString) -> Result<(), nsresult> {
        match status {
            ILoxRequestHandler::NO_ERROR => {
                match self.handler.try_borrow_mut().map_err(|_| NS_ERROR_FAILURE)?.take() {
                    Some(f) => {
                        (f)(response)
                    }
                    None => Err(NS_ERROR_NOT_AVAILABLE),
                }
            },
            ILoxRequestHandler::REQUEST_FAILED => self.call_error(ILoxCallback::REQUEST_FAILED, response),
            ILoxRequestHandler::UNREACHABLE => self.call_error(ILoxCallback::UNREACHABLE_AUTHORITY, response),
            _ => self.call_error(ILoxCallback::UNKNOWN, &nsCString::from(format!("Unknown response status {}", status))),
        }
    }

    fn call_error(&self, error_code: u32, message: &nsACString) -> Result<(), nsresult> {
        unsafe {
            self.callback.OnError(error_code, &*message)
        }.to_result()
    }
}

#[derive(Default, Serialize, Deserialize)]
struct LoxData {
    credentials: HashMap<String, LoxCredential>,
    // TODO: Check if this is the right type.
    invitations: Vec<Invitation>,
    pub_keys: Option<PubKeys>,
}

#[xpcom(implement(ILoxService), atomic)]
struct LoxService {
    // xpcom stuff usually is non-mut, so use RefCell for now...
    // Maybe a better idea is to have a single RefCell for a single struct,
    // which we use for actually implementing stuff.
    // It might even be a Rc<RefCell> if we want to implement the timer observer
    // separately.
    helper: RefCell<Option<RefPtr<ILoxServiceHelper>>>,
    data: RefCell<LoxData>,
}

impl LoxService {
    fn new() -> RefPtr<LoxService> {
        LoxService::allocate(InitLoxService {
            helper: RefCell::new(None),
            data: RefCell::new(LoxData::default()),
        })
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

        Ok(())
    }

    xpcom_method!(uninitialize => Uninitialize());
    fn uninitialize(&self) -> Result<(), nsresult> {
        match self.helper.try_borrow_mut() {
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
        }
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

    xpcom_method!(redeem_invite => RedeemInvite(invite: *const nsACString, callback: *const ILoxCallback));
    fn redeem_invite(&self, invite: &nsACString, callback: &ILoxCallback) -> Result<(), nsresult> {
        let self_ref = RefPtr::new(self);
        let callback_ref = RefPtr::new(callback);
        let invite: Invite =
            serde_json::from_value(json_from_string(invite)?).map_err(|_| NS_ERROR_INVALID_ARG)?;
        let token = validate(&invite.invite).map_err(|_| NS_ERROR_INVALID_ARG)?;
        let (request, state) = open_invite::request(&token);
        let request = serde_json::to_string(&request).map_err(|_| NS_ERROR_FAILURE)?;

        // TODO: Download the public keys

        self.make_request(
            "openreq",
            &request,
            RefPtr::new(callback),
            Box::new(|_val| { Ok(()) }),
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
        callback: RefPtr<ILoxCallback>,
        request_handler: Box<dyn FnOnce(&nsACString) -> Result<(), nsresult>>,
    ) -> Result<(), nsresult> {
        let procedure = nsCString::from(procedure);
        let request = nsCString::from(request);
        let handler = LoxRequestHandler::new(request_handler, callback);
        self.with_helper(move |h| {
            unsafe { h.RunRequest(&*procedure, &*request, handler.leak()) }.to_result()
        })
    }

    fn store(&self) -> Result<(), nsresult> {
        self.with_helper(|h| {
            self.read(move |data| {
                let data = serde_json::to_string(data).map_err(|_| NS_ERROR_FAILURE)?;
                let data = nsCString::from(data);
                unsafe { h.Store(&*data) }.to_result()
            })
        })
    }

    fn with_helper<F: FnOnce(RefPtr<ILoxServiceHelper>) -> Result<(), nsresult>>(
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
