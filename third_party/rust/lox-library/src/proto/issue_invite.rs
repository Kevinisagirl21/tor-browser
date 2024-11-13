/*! A module for the protocol for a user to request the issuing of an
Invitation credential they can pass to someone they know.

They are allowed to do this as long as their current Lox credentials has
a non-zero "invites_remaining" attribute (which will be decreased by
one), and they have a Bucket Reachability credential for their current
bucket and today's date.  (Such credentials are placed daily in the
encrypted bridge table.)

The user presents their current Lox credential:
- id: revealed
- bucket: blinded
- trust_level: blinded
- level_since: blinded
- invites_remaining: blinded, but proved in ZK that it's not zero
- blockages: blinded

and a Bucket Reachability credential:
- date: revealed to be today
- bucket: blinded, but proved in ZK that it's the same as in the Lox
  credential above

and a new Lox credential to be issued:

- id: jointly chosen by the user and BA
- bucket: blinded, but proved in ZK that it's the same as in the Lox
  credential above
- trust_level: blinded, but proved in ZK that it's the same as in the
  Lox credential above
- level_since: blinded, but proved in ZK that it's the same as in the
  Lox credential above
- invites_remaining: blinded, but proved in ZK that it's one less than
  the number in the Lox credential above
- blockages: blinded, but proved in ZK that it's the same as in the
  Lox credential above

and a new Invitation credential to be issued:

- inv_id: jointly chosen by the user and BA
- date: revealed to be today
- bucket: blinded, but proved in ZK that it's the same as in the Lox
  credential above
- blockages: blinded, but proved in ZK that it's the same as in the Lox
  credential above

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
use super::super::scalar_u32;
#[cfg(feature = "bridgeauth")]
use super::super::BridgeAuth;
use super::super::IssuerPubKey;
use super::super::{CMZ_A, CMZ_A_TABLE, CMZ_B, CMZ_B_TABLE};

use super::errors::CredentialError;

#[derive(Serialize, Deserialize)]
pub struct Request {
    // Fields for blind showing the Lox credential
    P: RistrettoPoint,
    id: Scalar,
    CBucket: RistrettoPoint,
    CLevel: RistrettoPoint,
    CSince: RistrettoPoint,
    CInvRemain: RistrettoPoint,
    CBlockages: RistrettoPoint,
    CQ: RistrettoPoint,

    // Fields for blind showing the Bucket Reachability credential
    P_reach: RistrettoPoint,
    CBucket_reach: RistrettoPoint,
    CQ_reach: RistrettoPoint,

    // Fields for user blinding of the Lox credential to be issued
    D: RistrettoPoint,
    EncIdClient: (RistrettoPoint, RistrettoPoint),
    EncBucket: (RistrettoPoint, RistrettoPoint),
    EncLevel: (RistrettoPoint, RistrettoPoint),
    EncSince: (RistrettoPoint, RistrettoPoint),
    EncInvRemain: (RistrettoPoint, RistrettoPoint),
    EncBlockages: (RistrettoPoint, RistrettoPoint),

    // Fields for user blinding of the Inivtation credential to be
    // issued
    EncInvIdClient: (RistrettoPoint, RistrettoPoint),
    // The bucket and blockages attributes in the Invitation credential
    // issuing protocol can just reuse the exact encryptions as for the
    // Lox credential issuing protocol above.

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
    EncInvIdClient: (RistrettoPoint, RistrettoPoint),
    id_client: Scalar,
    bucket: Scalar,
    level: Scalar,
    since: Scalar,
    invremain: Scalar,
    blockages: Scalar,
    inv_id_client: Scalar,
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

    // The fields for the new Invitation credential
    P_inv: RistrettoPoint,
    EncQ_inv: (RistrettoPoint, RistrettoPoint),
    inv_id_server: Scalar,
    TId_inv: RistrettoPoint,
    date_inv: Scalar,
    TBucket_inv: RistrettoPoint,
    TBlockages_inv: RistrettoPoint,

    // The ZKP
    piBlindIssue: CompactProof,
}

define_proof! {
    requestproof,
    "Issue Invite Request",
    (bucket, level, since, invremain, blockages, zbucket, zlevel,
     zsince, zinvremain, zblockages, negzQ,
     zbucket_reach, negzQ_reach,
     d, eid_client, ebucket, elevel, esince, einvremain, eblockages, id_client,
     inv_id_client, einv_id_client,
     invremain_inverse, zinvremain_inverse),
    (P, CBucket, CLevel, CSince, CInvRemain, CBlockages, V, Xbucket,
     Xlevel, Xsince, Xinvremain, Xblockages,
     P_reach, CBucket_reach, V_reach, Xbucket_reach,
     D, EncIdClient0, EncIdClient1, EncBucket0, EncBucket1,
     EncLevel0, EncLevel1, EncSince0, EncSince1,
     EncInvRemain0, EncInvRemain1_plus_B, EncBlockages0, EncBlockages1,
     EncInvIdClient0, EncInvIdClient1),
    (A, B):
    // Blind showing of the Lox credential
    CBucket = (bucket*P + zbucket*A),
    CLevel = (level*P + zlevel*A),
    CSince = (since*P + zsince*A),
    CInvRemain = (invremain*P + zinvremain*A),
    CBlockages = (blockages*P + zblockages*A),
    // Proof that invremain is not 0
    P = (invremain_inverse*CInvRemain + zinvremain_inverse*A),
    // Blind showing of the Bucket Reachability credential; note the
    // same bucket is used in the proof
    CBucket_reach = (bucket*P_reach + zbucket_reach*A),
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
    EncInvRemain1_plus_B = (invremain*B + einvremain*D),
    EncBlockages0 = (eblockages*B),
    EncBlockages1 = (blockages*B + eblockages*D),
    // User blinding of the Invitation to be issued
    EncInvIdClient0 = (einv_id_client*B),
    EncInvIdClient1 = (inv_id_client*B + einv_id_client*D)
}

define_proof! {
    blindissue,
    "Issue Invite Issuing",
    (x0, x0tilde, xid, xbucket, xlevel, xsince, xinvremain, xblockages,
     s, b, tid, tbucket, tlevel, tsince, tinvremain, tblockages,
     x0_inv, x0tilde_inv, xid_inv, xdate_inv, xbucket_inv,
     xblockages_inv,
     s_inv, b_inv, tid_inv, tbucket_inv, tblockages_inv),
    (P, EncQ0, EncQ1, X0, Xid, Xbucket, Xlevel, Xsince, Xinvremain,
     Xblockages, TId, TBucket, TLevel, TSince, TInvRemain, TBlockages,
     P_inv, EncQ_inv0, EncQ_inv1, X0_inv, Xid_inv, Xdate_inv,
     Xbucket_inv, Xblockages_inv, Pdate_inv, TId_inv, TBucket_inv,
     TBlockages_inv,
     D, EncId0, EncId1, EncBucket0, EncBucket1, EncLevel0, EncLevel1,
     EncSince0, EncSince1, EncInvRemain0, EncInvRemain1,
     EncBlockages0, EncBlockages1,
     EncInvId0, EncInvId1),
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
        + x0*P),
    Xid_inv = (xid_inv*A),
    Xdate_inv = (xdate_inv*A),
    Xbucket_inv = (xbucket_inv*A),
    Xblockages_inv = (xblockages_inv*A),
    X0_inv = (x0_inv*B + x0tilde_inv*A),
    P_inv = (b_inv*B),
    TId_inv = (b_inv*Xid_inv),
    TId_inv = (tid_inv*A),
    TBucket_inv = (b_inv*Xbucket_inv),
    TBucket_inv = (tbucket_inv*A),
    TBlockages_inv = (b_inv*Xblockages_inv),
    TBlockages_inv = (tblockages_inv*A),
    EncQ_inv0 = (s_inv*B + tid_inv*EncInvId0 + tbucket_inv*EncBucket0
        + tblockages_inv*EncBlockages0),
    EncQ_inv1 = (s_inv*D + tid_inv*EncInvId1 + tbucket_inv*EncBucket1
        + tblockages_inv*EncBlockages1 + x0_inv*P_inv + xdate_inv*Pdate_inv)
}

pub fn request(
    lox_cred: &cred::Lox,
    reach_cred: &cred::BucketReachability,
    lox_pub: &IssuerPubKey,
    reach_pub: &IssuerPubKey,
    today: u32,
) -> Result<(Request, State), CredentialError> {
    let A: &RistrettoPoint = &CMZ_A;
    let B: &RistrettoPoint = &CMZ_B;
    let Atable: &RistrettoBasepointTable = &CMZ_A_TABLE;
    let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

    // Ensure the credential can be correctly shown: it must be the case
    // that invites_remaining not be 0
    if lox_cred.invites_remaining == Scalar::ZERO {
        return Err(CredentialError::NoInvitationsRemaining);
    }
    // The buckets in the Lox and Bucket Reachability credentials have
    // to match
    if lox_cred.bucket != reach_cred.bucket {
        return Err(CredentialError::CredentialMismatch);
    }
    // The Bucket Reachability credential has to be dated today
    let reach_date: u32 = match scalar_u32(&reach_cred.date) {
        Some(v) => v,
        None => {
            return Err(CredentialError::InvalidField(
                String::from("date"),
                String::from("could not be converted to u32"),
            ))
        }
    };
    if reach_date != today {
        return Err(CredentialError::InvalidField(
            String::from("date"),
            String::from("reachability credential must be generated today"),
        ));
    }
    // The new invites_remaining
    let new_invites_remaining = lox_cred.invites_remaining - Scalar::ONE;

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

    // Blind showing the Bucket Reachability credential

    // Reblind P and Q
    let t_reach = Scalar::random(&mut rng);
    let P_reach = t_reach * reach_cred.P;
    let Q_reach = t_reach * reach_cred.Q;

    // Form Pedersen commitments to the blinded attributes
    let zbucket_reach = Scalar::random(&mut rng);
    let CBucket_reach = reach_cred.bucket * P_reach + &zbucket_reach * Atable;

    // Form a Pedersen commitment to the MAC Q
    // We flip the sign of zQ from that of the Hyphae paper so that
    // the ZKP has a "+" instead of a "-", as that's what the zkp
    // macro supports.
    let negzQ_reach = Scalar::random(&mut rng);
    let CQ_reach = Q_reach - &negzQ_reach * Atable;

    // Compute the "error factor"
    let V_reach = zbucket_reach * reach_pub.X[2] + &negzQ_reach * Atable;

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
        &new_invites_remaining * Btable + einvremain * D,
    );
    let eblockages = Scalar::random(&mut rng);
    let EncBlockages = (
        &eblockages * Btable,
        &lox_cred.blockages * Btable + eblockages * D,
    );

    // User blinding for the Invitation certificate to be issued

    // Pick a random client component of the id
    let inv_id_client = Scalar::random(&mut rng);

    // Encrypt it (times the basepoint B) to the ElGamal public key D we
    // just created
    let einv_id_client = Scalar::random(&mut rng);
    let EncInvIdClient = (
        &einv_id_client * Btable,
        &inv_id_client * Btable + einv_id_client * D,
    );

    // The proof that invites_remaining is not zero.  We prove this by
    // demonstrating that we know its inverse.
    let invremain_inverse = &lox_cred.invites_remaining.invert();

    let zinvremain_inverse = -zinvremain * invremain_inverse;

    // So now invremain_inverse * CInvRemain + zinvremain_inverse * A = P

    // Construct the proof
    let mut transcript = Transcript::new(b"issue invite request");
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
            P_reach: &P_reach,
            CBucket_reach: &CBucket_reach,
            V_reach: &V_reach,
            Xbucket_reach: &reach_pub.X[2],
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
            EncInvRemain1_plus_B: &(EncInvRemain.1 + B),
            EncBlockages0: &EncBlockages.0,
            EncBlockages1: &EncBlockages.1,
            EncInvIdClient0: &EncInvIdClient.0,
            EncInvIdClient1: &EncInvIdClient.1,
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
            zbucket_reach: &zbucket_reach,
            negzQ_reach: &negzQ_reach,
            d: &d,
            eid_client: &eid_client,
            ebucket: &ebucket,
            elevel: &elevel,
            esince: &esince,
            einvremain: &einvremain,
            eblockages: &eblockages,
            id_client: &id_client,
            inv_id_client: &inv_id_client,
            einv_id_client: &einv_id_client,
            invremain_inverse,
            zinvremain_inverse: &zinvremain_inverse,
        },
    )
    .0;

    Ok((
        Request {
            P,
            id: lox_cred.id,
            CBucket,
            CLevel,
            CSince,
            CInvRemain,
            CBlockages,
            CQ,
            P_reach,
            CBucket_reach,
            CQ_reach,
            D,
            EncIdClient,
            EncBucket,
            EncLevel,
            EncSince,
            EncInvRemain,
            EncBlockages,
            EncInvIdClient,
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
            EncInvIdClient,
            id_client,
            bucket: lox_cred.bucket,
            level: lox_cred.trust_level,
            since: lox_cred.level_since,
            invremain: new_invites_remaining,
            blockages: lox_cred.blockages,
            inv_id_client,
        },
    ))
}

#[cfg(feature = "bridgeauth")]
impl BridgeAuth {
    /// Receive an issue invite request
    pub fn handle_issue_invite(&mut self, req: Request) -> Result<Response, ProofError> {
        let A: &RistrettoPoint = &CMZ_A;
        let B: &RistrettoPoint = &CMZ_B;
        let Atable: &RistrettoBasepointTable = &CMZ_A_TABLE;
        let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

        if req.P.is_identity() || req.P_reach.is_identity() {
            return Err(ProofError::VerificationFailure);
        }

        let today: Scalar = self.today().into();

        // Recompute the "error factors" using knowledge of our own
        // (the issuer's) private key instead of knowledge of the
        // hidden attributes
        let Vprime = (self.lox_priv.x[0] + self.lox_priv.x[1] * req.id) * req.P
            + self.lox_priv.x[2] * req.CBucket
            + self.lox_priv.x[3] * req.CLevel
            + self.lox_priv.x[4] * req.CSince
            + self.lox_priv.x[5] * req.CInvRemain
            + self.lox_priv.x[6] * req.CBlockages
            - req.CQ;

        let Vprime_reach = (self.reachability_priv.x[0] + self.reachability_priv.x[1] * today)
            * req.P_reach
            + self.reachability_priv.x[2] * req.CBucket_reach
            - req.CQ_reach;

        // Verify the ZKP
        let mut transcript = Transcript::new(b"issue invite request");
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
                Xbucket: &self.lox_pub.X[2].compress(),
                Xlevel: &self.lox_pub.X[3].compress(),
                Xsince: &self.lox_pub.X[4].compress(),
                Xinvremain: &self.lox_pub.X[5].compress(),
                Xblockages: &self.lox_pub.X[6].compress(),
                P_reach: &req.P_reach.compress(),
                CBucket_reach: &req.CBucket_reach.compress(),
                V_reach: &Vprime_reach.compress(),
                Xbucket_reach: &self.reachability_pub.X[2].compress(),
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
                EncInvRemain1_plus_B: &(req.EncInvRemain.1 + B).compress(),
                EncBlockages0: &req.EncBlockages.0.compress(),
                EncBlockages1: &req.EncBlockages.1.compress(),
                EncInvIdClient0: &req.EncInvIdClient.0.compress(),
                EncInvIdClient1: &req.EncInvIdClient.1.compress(),
            },
        )?;

        // Ensure the id has not been seen before, and add it to the
        // seen list.
        if self.id_filter.filter(&req.id) == SeenType::Seen {
            return Err(ProofError::VerificationFailure);
        }

        // Blind issuing of the new Lox credential

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

        // Blind issuing of the new Invitation credential

        // Choose a random server id component to add to the client's
        // (blinded) id component
        let inv_id_server = Scalar::random(&mut rng);
        let EncInvId = (
            req.EncInvIdClient.0,
            req.EncInvIdClient.1 + &inv_id_server * Btable,
        );

        // Compute the MAC on the visible attributes
        let b_inv = Scalar::random(&mut rng);
        let P_inv = &b_inv * Btable;
        let QHc_inv = (self.invitation_priv.x[0] + self.invitation_priv.x[2] * today) * P_inv;

        // El Gamal encrypt it to the public key req.D
        let s_inv = Scalar::random(&mut rng);
        let EncQHc_inv = (&s_inv * Btable, QHc_inv + s_inv * req.D);

        // Homomorphically compute the part of the MAC corresponding to
        // the blinded attributes
        let tinvid = self.invitation_priv.x[1] * b_inv;
        let TId_inv = &tinvid * Atable;
        let EncQInvId = (tinvid * EncInvId.0, tinvid * EncInvId.1);
        let tinvbucket = self.invitation_priv.x[3] * b_inv;
        let TBucket_inv = &tinvbucket * Atable;
        // The bucket and blockages encrypted attributes are reused from
        // the Lox credential
        let EncQInvBucket = (tinvbucket * req.EncBucket.0, tinvbucket * req.EncBucket.1);
        let tinvblockages = self.invitation_priv.x[4] * b_inv;
        let TBlockages_inv = &tinvblockages * Atable;
        let EncQInvBlockages = (
            tinvblockages * req.EncBlockages.0,
            tinvblockages * req.EncBlockages.1,
        );

        let EncQ_inv = (
            EncQHc_inv.0 + EncQInvId.0 + EncQInvBucket.0 + EncQInvBlockages.0,
            EncQHc_inv.1 + EncQInvId.1 + EncQInvBucket.1 + EncQInvBlockages.1,
        );

        let mut transcript = Transcript::new(b"issue invite issuing");
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
                P_inv: &P_inv,
                EncQ_inv0: &EncQ_inv.0,
                EncQ_inv1: &EncQ_inv.1,
                X0_inv: &self.invitation_pub.X[0],
                Xid_inv: &self.invitation_pub.X[1],
                Xdate_inv: &self.invitation_pub.X[2],
                Xbucket_inv: &self.invitation_pub.X[3],
                Xblockages_inv: &self.invitation_pub.X[4],
                Pdate_inv: &(today * P_inv),
                TId_inv: &TId_inv,
                TBucket_inv: &TBucket_inv,
                TBlockages_inv: &TBlockages_inv,
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
                EncInvId0: &EncInvId.0,
                EncInvId1: &EncInvId.1,
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
                x0_inv: &self.invitation_priv.x[0],
                x0tilde_inv: &self.invitation_priv.x0tilde,
                xid_inv: &self.invitation_priv.x[1],
                xdate_inv: &self.invitation_priv.x[2],
                xbucket_inv: &self.invitation_priv.x[3],
                xblockages_inv: &self.invitation_priv.x[4],
                s_inv: &s_inv,
                b_inv: &b_inv,
                tid_inv: &tinvid,
                tbucket_inv: &tinvbucket,
                tblockages_inv: &tinvblockages,
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
            P_inv,
            EncQ_inv,
            inv_id_server,
            TId_inv,
            date_inv: today,
            TBucket_inv,
            TBlockages_inv,
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
    invitation_pub: &IssuerPubKey,
) -> Result<(cred::Lox, cred::Invitation), ProofError> {
    let A: &RistrettoPoint = &CMZ_A;
    let B: &RistrettoPoint = &CMZ_B;
    let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

    if resp.P.is_identity() || resp.P_inv.is_identity() {
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

    let inv_id = state.inv_id_client + resp.inv_id_server;
    let EncInvId = (
        state.EncInvIdClient.0,
        state.EncInvIdClient.1 + &resp.inv_id_server * Btable,
    );

    // Verify the proof
    let mut transcript = Transcript::new(b"issue invite issuing");
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
            P_inv: &resp.P_inv.compress(),
            EncQ_inv0: &resp.EncQ_inv.0.compress(),
            EncQ_inv1: &resp.EncQ_inv.1.compress(),
            X0_inv: &invitation_pub.X[0].compress(),
            Xid_inv: &invitation_pub.X[1].compress(),
            Xdate_inv: &invitation_pub.X[2].compress(),
            Xbucket_inv: &invitation_pub.X[3].compress(),
            Xblockages_inv: &invitation_pub.X[4].compress(),
            Pdate_inv: &(resp.date_inv * resp.P_inv).compress(),
            TId_inv: &resp.TId_inv.compress(),
            TBucket_inv: &resp.TBucket_inv.compress(),
            TBlockages_inv: &resp.TBlockages_inv.compress(),
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
            EncInvId0: &EncInvId.0.compress(),
            EncInvId1: &EncInvId.1.compress(),
        },
    )?;

    // Decrypt EncQ and EncQ_inv
    let Q = resp.EncQ.1 - (state.d * resp.EncQ.0);
    let Q_inv = resp.EncQ_inv.1 - (state.d * resp.EncQ_inv.0);

    Ok((
        cred::Lox {
            P: resp.P,
            Q,
            id,
            bucket: state.bucket,
            trust_level: state.level,
            level_since: state.since,
            invites_remaining: state.invremain,
            blockages: state.blockages,
        },
        cred::Invitation {
            P: resp.P_inv,
            Q: Q_inv,
            inv_id,
            date: resp.date_inv,
            bucket: state.bucket,
            blockages: state.blockages,
        },
    ))
}
