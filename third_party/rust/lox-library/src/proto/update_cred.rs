/*! A module for the protocol for a user to request the issuing of an updated credential after a key rotation has occurred


They are allowed to do this as long as their current Lox credential is valid

The user presents their current Lox credential:
- id: revealed
- bucket: blinded
- trust_level: blinded
- level_since: blinded
- invites_remaining: blinded
- blockages: blinded

and a new Lox credential to be issued:
- id: jointly chosen by the user and BA
- bucket: blinded, but proved in ZK that it's the same as in the Lox
  credential above
- trust_level: blinded, but proved in ZK that it's the same as in the
  Lox credential above
- level_since: blinded, but proved in ZK that it's the same as in the
  Lox credential above
- invites_remaining: blinded, but proved in ZK that it's the same as in the Lox credential above
- blockages: blinded, but proved in ZK that it's the same as in the
  Lox credential above

*/

use curve25519_dalek::ristretto::RistrettoBasepointTable;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::IsIdentity;

use lox_zkp::CompactProof;
use lox_zkp::ProofError;
use lox_zkp::Transcript;

use serde::{Deserialize, Serialize};

use super::super::cred;
#[cfg(feature = "bridgeauth")]
use super::super::dup_filter::SeenType;
#[cfg(feature = "bridgeauth")]
use super::super::BridgeAuth;
use super::super::IssuerPubKey;
use super::super::{CMZ_A, CMZ_A_TABLE, CMZ_B, CMZ_B_TABLE};

use super::errors::CredentialError;

#[derive(Serialize, Deserialize)]
pub struct Request {
    // Fields for blind showing the Lox credential
    OldPubKey: IssuerPubKey,
    P: RistrettoPoint,
    id: Scalar,
    CBucket: RistrettoPoint,
    CLevel: RistrettoPoint,
    CSince: RistrettoPoint,
    CInvRemain: RistrettoPoint,
    CBlockages: RistrettoPoint,
    CQ: RistrettoPoint,

    // Fields for user blinding of the Lox credential to be issued
    D: RistrettoPoint,
    EncIdClient: (RistrettoPoint, RistrettoPoint),
    EncBucket: (RistrettoPoint, RistrettoPoint),
    EncLevel: (RistrettoPoint, RistrettoPoint),
    EncSince: (RistrettoPoint, RistrettoPoint),
    EncInvRemain: (RistrettoPoint, RistrettoPoint),
    EncBlockages: (RistrettoPoint, RistrettoPoint),

    // The combined ZKP
    piUser: CompactProof,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct State {
    d: Scalar,
    D: RistrettoPoint,
    EncIdClient: (RistrettoPoint, RistrettoPoint),
    EncBucket: (RistrettoPoint, RistrettoPoint),
    EncLevel: (RistrettoPoint, RistrettoPoint),
    EncSince: (RistrettoPoint, RistrettoPoint),
    EncInvRemain: (RistrettoPoint, RistrettoPoint),
    EncBlockages: (RistrettoPoint, RistrettoPoint),
    id_client: Scalar,
    bucket: Scalar,
    level: Scalar,
    since: Scalar,
    invremain: Scalar,
    blockages: Scalar,
}

#[derive(Serialize, Deserialize)]
pub struct Response {
    // The fields for the new Lox credential; the new invites_remaining
    // is one less than the old value, so we don't have to include it
    // here explicitly
    P: RistrettoPoint,
    EncQ: (RistrettoPoint, RistrettoPoint),
    id_server: Scalar,
    TId: RistrettoPoint,
    TBucket: RistrettoPoint,
    TLevel: RistrettoPoint,
    TSince: RistrettoPoint,
    TInvRemain: RistrettoPoint,
    TBlockages: RistrettoPoint,

    // The ZKP
    piBlindIssue: CompactProof,
}

define_proof! {
    requestproof,
    "Update Credential Key Request",
    (bucket, level, since, invremain, blockages, zbucket, zlevel,
     zsince, zinvremain, zblockages, negzQ,
     d, eid_client, ebucket, elevel, esince, einvremain, eblockages, id_client
    ),
    (P, CBucket, CLevel, CSince, CInvRemain, CBlockages, V, Xbucket,
     Xlevel, Xsince, Xinvremain, Xblockages,
     D, EncIdClient0, EncIdClient1, EncBucket0, EncBucket1,
     EncLevel0, EncLevel1, EncSince0, EncSince1,
     EncInvRemain0, EncInvRemain1, EncBlockages0, EncBlockages1
     ),
    (A, B):
    // Blind showing of the Lox credential
    CBucket = (bucket*P + zbucket*A),
    CLevel = (level*P + zlevel*A),
    CSince = (since*P + zsince*A),
    CInvRemain = (invremain*P + zinvremain*A),
    CBlockages = (blockages*P + zblockages*A),
    // User blinding of the Lox credential to be issued
    D = (d*B),
    EncIdClient0 = (eid_client*B),
    EncIdClient1 = (id_client*B + eid_client*D),
    EncBucket0 = (ebucket*B),
    EncBucket1 = (bucket*B + ebucket*D),
    EncLevel0 = (elevel*B),
    EncLevel1 = (level*B + elevel*D),
    EncSince0 = (esince*B),
    EncSince1 = (since*B + esince*D),
    EncInvRemain0 = (einvremain*B),
    EncInvRemain1 = (invremain*B + einvremain*D),
    EncBlockages0 = (eblockages*B),
    EncBlockages1 = (blockages*B + eblockages*D)
}

define_proof! {
    blindissue,
    "Issue updated cred",
    (x0, x0tilde, xid, xbucket, xlevel, xsince, xinvremain, xblockages,
     s, b, tid, tbucket, tlevel, tsince, tinvremain, tblockages),
    (P, EncQ0, EncQ1, X0, Xid, Xbucket, Xlevel, Xsince, Xinvremain,
     Xblockages, TId, TBucket, TLevel, TSince, TInvRemain, TBlockages,
     D, EncId0, EncId1, EncBucket0, EncBucket1, EncLevel0, EncLevel1,
     EncSince0, EncSince1, EncInvRemain0, EncInvRemain1,
     EncBlockages0, EncBlockages1
    ),
    (A, B):
    Xid = (xid*A),
    Xbucket = (xbucket*A),
    Xlevel = (xlevel*A),
    Xsince = (xsince*A),
    Xinvremain = (xinvremain*A),
    Xblockages = (xblockages*A),
    X0 = (x0*B + x0tilde*A),
    P = (b*B),
    TId = (b*Xid),
    TId = (tid*A),
    TBucket = (b*Xbucket),
    TBucket = (tbucket*A),
    TLevel = (b*Xlevel),
    TLevel = (tlevel*A),
    TSince = (b*Xsince),
    TSince = (tsince*A),
    TInvRemain = (b*Xinvremain),
    TInvRemain = (tinvremain*A),
    TBlockages = (b*Xblockages),
    TBlockages = (tblockages*A),
    EncQ0 = (s*B + tid*EncId0 + tbucket*EncBucket0 + tlevel*EncLevel0
        + tsince*EncSince0 + tinvremain*EncInvRemain0 + tblockages*EncBlockages0),
    EncQ1 = (s*D + tid*EncId1 + tbucket*EncBucket1 + tlevel*EncLevel1
        + tsince*EncSince1 + tinvremain*EncInvRemain1 + tblockages*EncBlockages1
        + x0*P)
}

pub fn request(
    lox_cred: &cred::Lox,
    lox_pub: &IssuerPubKey,
) -> Result<(Request, State), CredentialError> {
    let A: &RistrettoPoint = &CMZ_A;
    let B: &RistrettoPoint = &CMZ_B;
    let Atable: &RistrettoBasepointTable = &CMZ_A_TABLE;
    let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

    // Blind showing the Lox credential

    // Reblind P and Q
    let mut rng = rand::thread_rng();
    let t = Scalar::random(&mut rng);
    let P = t * lox_cred.P;
    let Q = t * lox_cred.Q;

    // Form Pedersen commitments to the blinded attributes
    let zbucket = Scalar::random(&mut rng);
    let zlevel = Scalar::random(&mut rng);
    let zsince = Scalar::random(&mut rng);
    let zinvremain = Scalar::random(&mut rng);
    let zblockages = Scalar::random(&mut rng);
    let CBucket = lox_cred.bucket * P + &zbucket * Atable;
    let CLevel = lox_cred.trust_level * P + &zlevel * Atable;
    let CSince = lox_cred.level_since * P + &zsince * Atable;
    let CInvRemain = lox_cred.invites_remaining * P + &zinvremain * Atable;
    let CBlockages = lox_cred.blockages * P + &zblockages * Atable;

    // Form a Pedersen commitment to the MAC Q
    // We flip the sign of zQ from that of the Hyphae paper so that
    // the ZKP has a "+" instead of a "-", as that's what the zkp
    // macro supports.
    let negzQ = Scalar::random(&mut rng);
    let CQ = Q - &negzQ * Atable;

    // Compute the "error factor"
    let V = zbucket * lox_pub.X[2]
        + zlevel * lox_pub.X[3]
        + zsince * lox_pub.X[4]
        + zinvremain * lox_pub.X[5]
        + zblockages * lox_pub.X[6]
        + &negzQ * Atable;

    // User blinding for the Lox certificate to be issued

    // Pick an ElGamal keypair
    let d = Scalar::random(&mut rng);
    let D = &d * Btable;

    // Pick a random client component of the id
    let id_client = Scalar::random(&mut rng);

    // Encrypt it (times the basepoint B) to the ElGamal public key D we
    // just created
    let eid_client = Scalar::random(&mut rng);
    let EncIdClient = (&eid_client * Btable, &id_client * Btable + eid_client * D);

    // Encrypt the other blinded fields (times B) to D as well
    let ebucket = Scalar::random(&mut rng);
    let EncBucket = (&ebucket * Btable, &lox_cred.bucket * Btable + ebucket * D);
    let elevel = Scalar::random(&mut rng);
    let EncLevel = (
        &elevel * Btable,
        &lox_cred.trust_level * Btable + elevel * D,
    );
    let esince = Scalar::random(&mut rng);
    let EncSince = (
        &esince * Btable,
        &lox_cred.level_since * Btable + esince * D,
    );
    let einvremain = Scalar::random(&mut rng);
    let EncInvRemain = (
        &einvremain * Btable,
        &lox_cred.invites_remaining * Btable + einvremain * D,
    );
    let eblockages = Scalar::random(&mut rng);
    let EncBlockages = (
        &eblockages * Btable,
        &lox_cred.blockages * Btable + eblockages * D,
    );

    // Construct the proof
    let mut transcript = Transcript::new(b"update credential key request");
    let piUser = requestproof::prove_compact(
        &mut transcript,
        requestproof::ProveAssignments {
            A,
            B,
            P: &P,
            CBucket: &CBucket,
            CLevel: &CLevel,
            CSince: &CSince,
            CInvRemain: &CInvRemain,
            CBlockages: &CBlockages,
            V: &V,
            Xbucket: &lox_pub.X[2],
            Xlevel: &lox_pub.X[3],
            Xsince: &lox_pub.X[4],
            Xinvremain: &lox_pub.X[5],
            Xblockages: &lox_pub.X[6],
            D: &D,
            EncIdClient0: &EncIdClient.0,
            EncIdClient1: &EncIdClient.1,
            EncBucket0: &EncBucket.0,
            EncBucket1: &EncBucket.1,
            EncLevel0: &EncLevel.0,
            EncLevel1: &EncLevel.1,
            EncSince0: &EncSince.0,
            EncSince1: &EncSince.1,
            EncInvRemain0: &EncInvRemain.0,
            EncInvRemain1: &EncInvRemain.1,
            EncBlockages0: &EncBlockages.0,
            EncBlockages1: &EncBlockages.1,
            bucket: &lox_cred.bucket,
            level: &lox_cred.trust_level,
            since: &lox_cred.level_since,
            invremain: &lox_cred.invites_remaining,
            blockages: &lox_cred.blockages,
            zbucket: &zbucket,
            zlevel: &zlevel,
            zsince: &zsince,
            zinvremain: &zinvremain,
            zblockages: &zblockages,
            negzQ: &negzQ,
            d: &d,
            eid_client: &eid_client,
            ebucket: &ebucket,
            elevel: &elevel,
            esince: &esince,
            einvremain: &einvremain,
            eblockages: &eblockages,
            id_client: &id_client,
        },
    )
    .0;

    Ok((
        Request {
            OldPubKey: lox_pub.clone(),
            P,
            id: lox_cred.id,
            CBucket,
            CLevel,
            CSince,
            CInvRemain,
            CBlockages,
            CQ,
            D,
            EncIdClient,
            EncBucket,
            EncLevel,
            EncSince,
            EncInvRemain,
            EncBlockages,
            piUser,
        },
        State {
            d,
            D,
            EncIdClient,
            EncBucket,
            EncLevel,
            EncSince,
            EncInvRemain,
            EncBlockages,
            id_client,
            bucket: lox_cred.bucket,
            level: lox_cred.trust_level,
            since: lox_cred.level_since,
            invremain: lox_cred.invites_remaining,
            blockages: lox_cred.blockages,
        },
    ))
}

#[cfg(feature = "bridgeauth")]
impl BridgeAuth {
    /// Receive an issue invite request
    pub fn handle_update_cred(&mut self, req: Request) -> Result<Response, ProofError> {
        let A: &RistrettoPoint = &CMZ_A;
        let B: &RistrettoPoint = &CMZ_B;
        let Atable: &RistrettoBasepointTable = &CMZ_A_TABLE;
        let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

        if req.P.is_identity() {
            return Err(ProofError::VerificationFailure);
        }

        // Both of these must be true and should be true after rotate_lox_keys is called
        if self.old_keys.lox_keys.is_empty() || self.old_filters.lox_filter.is_empty() {
            return Err(ProofError::VerificationFailure);
        }

        // calling this function will automatically use the most recent old private key for
        // verification and the new private key for issuing.

        // Recompute the "error factors" using knowledge of our own
        // (the issuer's) outdated private key instead of knowledge of the
        // hidden attributes
        let old_keys = match self
            .old_keys
            .lox_keys
            .iter()
            .find(|x| x.pub_key == req.OldPubKey)
        {
            Some(old_keys) => old_keys,
            None => return Err(ProofError::VerificationFailure),
        };
        let index = self
            .old_keys
            .lox_keys
            .iter()
            .position(|x| x.pub_key == old_keys.pub_key)
            .unwrap();

        let old_priv_key = old_keys.priv_key.clone();
        let old_pub_key = old_keys.pub_key.clone();
        let Vprime = (old_priv_key.x[0] + old_priv_key.x[1] * req.id) * req.P
            + old_priv_key.x[2] * req.CBucket
            + old_priv_key.x[3] * req.CLevel
            + old_priv_key.x[4] * req.CSince
            + old_priv_key.x[5] * req.CInvRemain
            + old_priv_key.x[6] * req.CBlockages
            - req.CQ;

        // Verify the ZKP
        let mut transcript = Transcript::new(b"update credential key request");
        requestproof::verify_compact(
            &req.piUser,
            &mut transcript,
            requestproof::VerifyAssignments {
                A: &A.compress(),
                B: &B.compress(),
                P: &req.P.compress(),
                CBucket: &req.CBucket.compress(),
                CLevel: &req.CLevel.compress(),
                CSince: &req.CSince.compress(),
                CInvRemain: &req.CInvRemain.compress(),
                CBlockages: &req.CBlockages.compress(),
                V: &Vprime.compress(),
                Xbucket: &old_pub_key.X[2].compress(),
                Xlevel: &old_pub_key.X[3].compress(),
                Xsince: &old_pub_key.X[4].compress(),
                Xinvremain: &old_pub_key.X[5].compress(),
                Xblockages: &old_pub_key.X[6].compress(),
                D: &req.D.compress(),
                EncIdClient0: &req.EncIdClient.0.compress(),
                EncIdClient1: &req.EncIdClient.1.compress(),
                EncBucket0: &req.EncBucket.0.compress(),
                EncBucket1: &req.EncBucket.1.compress(),
                EncLevel0: &req.EncLevel.0.compress(),
                EncLevel1: &req.EncLevel.1.compress(),
                EncSince0: &req.EncSince.0.compress(),
                EncSince1: &req.EncSince.1.compress(),
                EncInvRemain0: &req.EncInvRemain.0.compress(),
                EncInvRemain1: &req.EncInvRemain.1.compress(),
                EncBlockages0: &req.EncBlockages.0.compress(),
                EncBlockages1: &req.EncBlockages.1.compress(),
            },
        )?;

        // Check the old_lox_id_filter for the id.
        // Ensure the id has not been seen before, and add it to the
        // seen list.
        if self
            .old_filters
            .lox_filter
            .get_mut(index)
            .unwrap()
            .filter(&req.id)
            == SeenType::Seen
        {
            return Err(ProofError::VerificationFailure);
        }

        // Blind issuing of the new Lox credential using the new key

        // Choose a random server id component to add to the client's
        // (blinded) id component
        let mut rng = rand::thread_rng();
        let id_server = Scalar::random(&mut rng);
        let EncId = (req.EncIdClient.0, req.EncIdClient.1 + &id_server * Btable);

        // Compute the MAC on the visible attributes (none here)
        let b = Scalar::random(&mut rng);
        let P = &b * Btable;
        let QHc = self.lox_priv.x[0] * P;

        // El Gamal encrypt it to the public key req.D
        let s = Scalar::random(&mut rng);
        let EncQHc = (&s * Btable, QHc + s * req.D);

        // Homomorphically compute the part of the MAC corresponding to
        // the blinded attributes
        let tid = self.lox_priv.x[1] * b;
        let TId = &tid * Atable;
        let EncQId = (tid * EncId.0, tid * EncId.1);
        let tbucket = self.lox_priv.x[2] * b;
        let TBucket = &tbucket * Atable;
        let EncQBucket = (tbucket * req.EncBucket.0, tbucket * req.EncBucket.1);
        let tlevel = self.lox_priv.x[3] * b;
        let TLevel = &tlevel * Atable;
        let EncQLevel = (tlevel * req.EncLevel.0, tlevel * req.EncLevel.1);
        let tsince = self.lox_priv.x[4] * b;
        let TSince = &tsince * Atable;
        let EncQSince = (tsince * req.EncSince.0, tsince * req.EncSince.1);
        let tinvremain = self.lox_priv.x[5] * b;
        let TInvRemain = &tinvremain * Atable;
        let EncQInvRemain = (
            tinvremain * req.EncInvRemain.0,
            tinvremain * req.EncInvRemain.1,
        );
        let tblockages = self.lox_priv.x[6] * b;
        let TBlockages = &tblockages * Atable;
        let EncQBlockages = (
            tblockages * req.EncBlockages.0,
            tblockages * req.EncBlockages.1,
        );

        let EncQ = (
            EncQHc.0
                + EncQId.0
                + EncQBucket.0
                + EncQLevel.0
                + EncQSince.0
                + EncQInvRemain.0
                + EncQBlockages.0,
            EncQHc.1
                + EncQId.1
                + EncQBucket.1
                + EncQLevel.1
                + EncQSince.1
                + EncQInvRemain.1
                + EncQBlockages.1,
        );

        let mut transcript = Transcript::new(b"issue updated cred");
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
                Xlevel: &self.lox_pub.X[3],
                Xsince: &self.lox_pub.X[4],
                Xinvremain: &self.lox_pub.X[5],
                Xblockages: &self.lox_pub.X[6],
                TId: &TId,
                TBucket: &TBucket,
                TLevel: &TLevel,
                TSince: &TSince,
                TInvRemain: &TInvRemain,
                TBlockages: &TBlockages,
                D: &req.D,
                EncId0: &EncId.0,
                EncId1: &EncId.1,
                EncBucket0: &req.EncBucket.0,
                EncBucket1: &req.EncBucket.1,
                EncLevel0: &req.EncLevel.0,
                EncLevel1: &req.EncLevel.1,
                EncSince0: &req.EncSince.0,
                EncSince1: &req.EncSince.1,
                EncInvRemain0: &req.EncInvRemain.0,
                EncInvRemain1: &req.EncInvRemain.1,
                EncBlockages0: &req.EncBlockages.0,
                EncBlockages1: &req.EncBlockages.1,
                x0: &self.lox_priv.x[0],
                x0tilde: &self.lox_priv.x0tilde,
                xid: &self.lox_priv.x[1],
                xbucket: &self.lox_priv.x[2],
                xlevel: &self.lox_priv.x[3],
                xsince: &self.lox_priv.x[4],
                xinvremain: &self.lox_priv.x[5],
                xblockages: &self.lox_priv.x[6],
                s: &s,
                b: &b,
                tid: &tid,
                tbucket: &tbucket,
                tlevel: &tlevel,
                tsince: &tsince,
                tinvremain: &tinvremain,
                tblockages: &tblockages,
            },
        )
        .0;

        Ok(Response {
            P,
            EncQ,
            id_server,
            TId,
            TBucket,
            TLevel,
            TSince,
            TInvRemain,
            TBlockages,
            piBlindIssue,
        })
    }
}

/// Handle the response to the request, producing the new Lox credential
/// and Invitation credential if successful.
pub fn handle_response(
    state: State,
    resp: Response,
    lox_pub: &IssuerPubKey,
) -> Result<cred::Lox, ProofError> {
    let A: &RistrettoPoint = &CMZ_A;
    let B: &RistrettoPoint = &CMZ_B;
    let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

    if resp.P.is_identity() {
        return Err(ProofError::VerificationFailure);
    }

    // Add the server's contribution to the id to our own, both in plain
    // and encrypted form and for both the Lox credential id and the
    // Invitation credential id
    let id = state.id_client + resp.id_server;
    let EncId = (
        state.EncIdClient.0,
        state.EncIdClient.1 + &resp.id_server * Btable,
    );

    // Verify the proof
    let mut transcript = Transcript::new(b"issue updated cred");
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
            Xlevel: &lox_pub.X[3].compress(),
            Xsince: &lox_pub.X[4].compress(),
            Xinvremain: &lox_pub.X[5].compress(),
            Xblockages: &lox_pub.X[6].compress(),
            TId: &resp.TId.compress(),
            TBucket: &resp.TBucket.compress(),
            TLevel: &resp.TLevel.compress(),
            TSince: &resp.TSince.compress(),
            TInvRemain: &resp.TInvRemain.compress(),
            TBlockages: &resp.TBlockages.compress(),
            D: &state.D.compress(),
            EncId0: &EncId.0.compress(),
            EncId1: &EncId.1.compress(),
            EncBucket0: &state.EncBucket.0.compress(),
            EncBucket1: &state.EncBucket.1.compress(),
            EncLevel0: &state.EncLevel.0.compress(),
            EncLevel1: &state.EncLevel.1.compress(),
            EncSince0: &state.EncSince.0.compress(),
            EncSince1: &state.EncSince.1.compress(),
            EncInvRemain0: &state.EncInvRemain.0.compress(),
            EncInvRemain1: &state.EncInvRemain.1.compress(),
            EncBlockages0: &state.EncBlockages.0.compress(),
            EncBlockages1: &state.EncBlockages.1.compress(),
        },
    )?;

    // Decrypt EncQ and EncQ_inv
    let Q = resp.EncQ.1 - (state.d * resp.EncQ.0);

    Ok(cred::Lox {
        P: resp.P,
        Q,
        id,
        bucket: state.bucket,
        trust_level: state.level,
        level_since: state.since,
        invites_remaining: state.invremain,
        blockages: state.blockages,
    })
}
