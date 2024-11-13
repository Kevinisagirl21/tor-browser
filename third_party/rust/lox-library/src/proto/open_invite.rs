/*! A module for the protocol for the user to redeem an open invitation
with the BA (bridge authority) to receive their initial Lox
credential.

The credential will have attributes:

- id: jointly chosen by the user and BA
- bucket: set by the BA
- trust_level: 0
- level_since: today
- invites_remaining: 0
- blockages: 0

*/

use curve25519_dalek::ristretto::RistrettoBasepointTable;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::IsIdentity;

use lox_zkp::CompactProof;
use lox_zkp::ProofError;
use lox_zkp::Transcript;

use serde::{Deserialize, Serialize};
use serde_with::serde_as;

#[cfg(feature = "bridgeauth")]
use super::super::bridge_table;
use super::super::bridge_table::BridgeLine;
use super::super::cred;
#[cfg(feature = "bridgeauth")]
use super::super::dup_filter::SeenType;
use super::super::OPENINV_LENGTH;
#[cfg(feature = "bridgeauth")]
use super::super::{BridgeAuth, BridgeDb};
use super::super::IssuerPubKey;
use super::super::{CMZ_A, CMZ_B, CMZ_B_TABLE};
#[cfg(feature = "bridgeauth")]
use super::super::CMZ_A_TABLE;

/// The request message for this protocol
#[serde_as]
#[derive(Serialize, Deserialize)]
pub struct Request {
    #[serde_as(as = "[_; OPENINV_LENGTH]")]
    invite: [u8; OPENINV_LENGTH],
    D: RistrettoPoint,
    EncIdClient: (RistrettoPoint, RistrettoPoint),
    piUserBlinding: CompactProof,
}

/// The client state for this protocol
#[derive(Debug, Serialize, Deserialize)]
pub struct State {
    d: Scalar,
    D: RistrettoPoint,
    EncIdClient: (RistrettoPoint, RistrettoPoint),
    id_client: Scalar,
}

/// The response message for this protocol
#[derive(Serialize, Deserialize)]
pub struct Response {
    P: RistrettoPoint,
    EncQ: (RistrettoPoint, RistrettoPoint),
    id_server: Scalar,
    TId: RistrettoPoint,
    bucket: Scalar,
    level_since: Scalar,
    piBlindIssue: CompactProof,
    bridge_line: BridgeLine,
}

// The userblinding ZKP
define_proof! {
    userblinding,
    "Open Invitation User Blinding",
    (d, eid_client, id_client),
    (D, EncIdClient0, EncIdClient1),
    (B) :
    D = (d*B),
    EncIdClient0 = (eid_client*B),
    EncIdClient1 = (id_client*B + eid_client*D)
}

// The issuing ZKP
define_proof! {
    blindissue,
    "Open Invitation Blind Issuing",
    (x0, x0tilde, xid, xbucket, xsince, s, b, tid),
    (P, EncQ0, EncQ1, X0, Xid, Xbucket, Xsince, Pbucket, Psince, TId,
     D, EncId0, EncId1),
    (A, B) :
    Xid = (xid*A),
    Xbucket = (xbucket*A),
    Xsince = (xsince*A),
    X0 = (x0*B + x0tilde*A),
    P = (b*B),
    TId = (b*Xid),
    TId = (tid*A),
    EncQ0 = (s*B + tid*EncId0),
    EncQ1 = (s*D + tid*EncId1 + x0*P + xbucket*Pbucket + xsince*Psince)
}

/// Submit an open invitation issued by the BridgeDb to receive your
/// first Lox credential
pub fn request(invite: &[u8; OPENINV_LENGTH]) -> (Request, State) {
    let B: &RistrettoPoint = &CMZ_B;
    let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

    // Pick an ElGamal keypair
    let mut rng = rand::thread_rng();
    let d = Scalar::random(&mut rng);
    let D = &d * Btable;

    // Pick a random client component of the id
    let id_client = Scalar::random(&mut rng);

    // Encrypt it (times the basepoint B) to the ElGamal public key D we
    // just created
    let eid_client = Scalar::random(&mut rng);
    let EncIdClient = (&eid_client * Btable, &id_client * Btable + eid_client * D);

    // Construct the proof of correct user blinding
    let mut transcript = Transcript::new(b"open invite user blinding");
    let piUserBlinding = userblinding::prove_compact(
        &mut transcript,
        userblinding::ProveAssignments {
            B,
            D: &D,
            EncIdClient0: &EncIdClient.0,
            EncIdClient1: &EncIdClient.1,
            d: &d,
            eid_client: &eid_client,
            id_client: &id_client,
        },
    )
    .0;
    (
        Request {
            invite: *invite,
            D,
            EncIdClient,
            piUserBlinding,
        },
        State {
            d,
            D,
            EncIdClient,
            id_client,
        },
    )
}

#[cfg(feature = "bridgeauth")]
impl BridgeAuth {
    /// Receive an open invitation issued by the BridgeDb and if it is
    /// valid and fresh, issue a Lox credential at trust level 0.
    pub fn handle_open_invite(&mut self, req: Request) -> Result<Response, ProofError> {
        // Check the signature on the open_invite, first with the old key, then with the new key.
        // We manually match here because we're changing the Err type from SignatureError
        // to ProofError
        let mut old_token: Option<((Scalar, u32), usize)> = Default::default();
        let invite_id: Scalar;
        let bucket_id: u32;
        // If there are old openinv keys, check them first
        for (i, old_openinv_key) in self.old_keys.bridgedb_key.iter().enumerate() {
            old_token = match BridgeDb::verify(req.invite, *old_openinv_key) {
                Ok(res) => Some((res, i)),
                Err(_) => None,
            };
        }

        // Check if verifying with the old key succeeded, if it did, check if it has been seen
        if old_token.is_some() {
            // Only proceed if the invite_id is fresh
            (invite_id, bucket_id) = old_token.unwrap().0;
            if self
                .old_filters
                .openinv_filter
                .get_mut(old_token.unwrap().1)
                .unwrap()
                .filter(&invite_id)
                == SeenType::Seen
            {
                return Err(ProofError::VerificationFailure);
            }
        // If it didn't, try verifying with the new key
        } else {
            (invite_id, bucket_id) = match BridgeDb::verify(req.invite, self.bridgedb_pub) {
                Ok(res) => res,
                // Also verify that the request doesn't match with an old openinv_key
                Err(_) => return Err(ProofError::VerificationFailure),
            };
            // Only proceed if the invite_id is fresh
            if self.bridgedb_pub_filter.filter(&invite_id) == SeenType::Seen {
                return Err(ProofError::VerificationFailure);
            }
        }

        // And also check that the bucket id is valid
        if !self.bridge_table.buckets.contains_key(&bucket_id) {
            return Err(ProofError::VerificationFailure);
        }

        let A: &RistrettoPoint = &CMZ_A;
        let B: &RistrettoPoint = &CMZ_B;
        let Atable: &RistrettoBasepointTable = &CMZ_A_TABLE;
        let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

        // Next check the proof in the request
        let mut transcript = Transcript::new(b"open invite user blinding");
        userblinding::verify_compact(
            &req.piUserBlinding,
            &mut transcript,
            userblinding::VerifyAssignments {
                B: &B.compress(),
                EncIdClient0: &req.EncIdClient.0.compress(),
                EncIdClient1: &req.EncIdClient.1.compress(),
                D: &req.D.compress(),
            },
        )?;

        // Choose a random server id component to add to the client's
        // (blinded) id component
        let mut rng = rand::thread_rng();
        let id_server = Scalar::random(&mut rng);
        let EncId = (req.EncIdClient.0, req.EncIdClient.1 + &id_server * Btable);

        // Create the bucket attribute (Scalar), which is a combination
        // of the bucket id (u32) and the bucket's decryption key ([u8; 16])
        let bucket_key = self.bridge_table.keys.get(&bucket_id).unwrap();
        let bucket: Scalar = bridge_table::to_scalar(bucket_id, bucket_key);
        let bridge_lines = self.bridge_table.buckets.get(&bucket_id).unwrap();
        let bridge_line = bridge_lines[0];

        // Create the level_since attribute (Scalar), which is today's
        // Julian date
        let level_since: Scalar = self.today().into();

        // Compute the MAC on the visible attributes
        let b = Scalar::random(&mut rng);
        let P = &b * Btable;
        // trust_level = invites_remaining = blockages = 0
        let QHc =
            (self.lox_priv.x[0] + self.lox_priv.x[2] * bucket + self.lox_priv.x[4] * level_since)
                * P;

        // El Gamal encrypt it to the public key req.D
        let s = Scalar::random(&mut rng);
        let EncQHc = (&s * Btable, QHc + s * req.D);

        // Homomorphically compute the part of the MAC corresponding to
        // the blinded id attribute
        let tid = self.lox_priv.x[1] * b;
        let TId = &tid * Atable;
        let EncQId = (tid * EncId.0, tid * EncId.1);

        let EncQ = (EncQHc.0 + EncQId.0, EncQHc.1 + EncQId.1);

        let mut transcript = Transcript::new(b"open invite issuing");
        let piBlindIssue = blindissue::prove_compact(
            &mut transcript,
            blindissue::ProveAssignments {
                A,
                B,
                P: &P,
                EncQ0: &EncQ.0,
                EncQ1: &EncQ.1,
                X0: &self.lox_pub.X[0],
                Xid: &self.lox_pub.X[1],
                Xbucket: &self.lox_pub.X[2],
                Xsince: &self.lox_pub.X[4],
                Pbucket: &(bucket * P),
                Psince: &(level_since * P),
                TId: &TId,
                D: &req.D,
                EncId0: &EncId.0,
                EncId1: &EncId.1,
                x0: &self.lox_priv.x[0],
                x0tilde: &self.lox_priv.x0tilde,
                xid: &self.lox_priv.x[1],
                xbucket: &self.lox_priv.x[2],
                xsince: &self.lox_priv.x[4],
                s: &s,
                b: &b,
                tid: &tid,
            },
        )
        .0;

        Ok(Response {
            P,
            EncQ,
            id_server,
            TId,
            bucket,
            level_since,
            piBlindIssue,
            bridge_line,
        })
    }
}

/// Handle the reponse to the request, producing the desired Lox
/// credential if successful.
pub fn handle_response(
    state: State,
    resp: Response,
    lox_pub: &IssuerPubKey,
) -> Result<(cred::Lox, BridgeLine), ProofError> {
    let A: &RistrettoPoint = &CMZ_A;
    let B: &RistrettoPoint = &CMZ_B;
    let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

    if resp.P.is_identity() {
        return Err(ProofError::VerificationFailure);
    }

    // Add the server's contribution to the id to our own, both in plain
    // and encrypted form
    let id = state.id_client + resp.id_server;
    let EncId = (
        state.EncIdClient.0,
        state.EncIdClient.1 + &resp.id_server * Btable,
    );

    // Verify the proof
    let mut transcript = Transcript::new(b"open invite issuing");
    blindissue::verify_compact(
        &resp.piBlindIssue,
        &mut transcript,
        blindissue::VerifyAssignments {
            A: &A.compress(),
            B: &B.compress(),
            P: &resp.P.compress(),
            EncQ0: &resp.EncQ.0.compress(),
            EncQ1: &resp.EncQ.1.compress(),
            X0: &lox_pub.X[0].compress(),
            Xid: &lox_pub.X[1].compress(),
            Xbucket: &lox_pub.X[2].compress(),
            Xsince: &lox_pub.X[4].compress(),
            Pbucket: &(resp.bucket * resp.P).compress(),
            Psince: &(resp.level_since * resp.P).compress(),
            TId: &resp.TId.compress(),
            D: &state.D.compress(),
            EncId0: &EncId.0.compress(),
            EncId1: &EncId.1.compress(),
        },
    )?;

    // Decrypt EncQ
    let Q = resp.EncQ.1 - (state.d * resp.EncQ.0);

    Ok((
        cred::Lox {
            P: resp.P,
            Q,
            id,
            bucket: resp.bucket,
            trust_level: Scalar::ZERO,
            level_since: resp.level_since,
            invites_remaining: Scalar::ZERO,
            blockages: Scalar::ZERO,
        },
        resp.bridge_line,
    ))
}
