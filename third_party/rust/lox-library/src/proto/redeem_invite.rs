/*! A module for the protocol for a new user to redeem an Invitation
credential.  The user will start at trust level 1 (instead of 0 for
untrusted uninvited users).

The user presents the Invitation credential:
- id: revealed
- date: blinded, but proved in ZK to be at most INVITATION_EXPIRY days ago
- bucket: blinded
- blockages: blinded

and a new Lox credential to be issued:

- id: jointly chosen by the user and BA
- bucket: blinded, but proved in ZK that it's the same as in the
  Invitation credential above
- trust_level: revealed to be 1
- level_since: today
- invites_remaining: revealed to be 0
- blockages: blinded, but proved in ZK that it's the same as in the
  Invitations credential above

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
use super::super::pt_dbl;
use super::super::{scalar_dbl, scalar_u32};
#[cfg(feature = "bridgeauth")]
use super::super::BridgeAuth;
use super::super::IssuerPubKey;
use super::super::{CMZ_A, CMZ_A_TABLE, CMZ_B, CMZ_B_TABLE};

use super::errors::CredentialError;

/// Invitations must be used within this many days of being issued.
/// Note that if you change this number to be larger than 15, you must
/// also add bits to the zero knowledge proof.
pub const INVITATION_EXPIRY: u32 = 15;

#[derive(Serialize, Deserialize)]
pub struct Request {
    // Fields for showing the Invitation credential
    P: RistrettoPoint,
    inv_id: Scalar,
    CDate: RistrettoPoint,
    CBucket: RistrettoPoint,
    CBlockages: RistrettoPoint,
    CQ: RistrettoPoint,

    // Fields for the inequality proof
    // date + INVITATION_EXPIRY >= today
    CG1: RistrettoPoint,
    CG2: RistrettoPoint,
    CG3: RistrettoPoint,
    CG0sq: RistrettoPoint,
    CG1sq: RistrettoPoint,
    CG2sq: RistrettoPoint,
    CG3sq: RistrettoPoint,

    // Fields for user blinding of the Lox credential to be issued
    D: RistrettoPoint,
    EncIdClient: (RistrettoPoint, RistrettoPoint),
    EncBucket: (RistrettoPoint, RistrettoPoint),
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
    EncBlockages: (RistrettoPoint, RistrettoPoint),
    id_client: Scalar,
    bucket: Scalar,
    blockages: Scalar,
}

#[derive(Serialize, Deserialize)]
pub struct Response {
    // The fields for the new Lox credential; the new trust level is 1
    // and the new invites_remaining is 0, so we don't have to include
    // them here explicitly
    P: RistrettoPoint,
    EncQ: (RistrettoPoint, RistrettoPoint),
    id_server: Scalar,
    level_since: Scalar,
    TId: RistrettoPoint,
    TBucket: RistrettoPoint,
    TBlockages: RistrettoPoint,

    // The ZKP
    piBlindIssue: CompactProof,
}

define_proof! {
    requestproof,
    "Redeem Invite Request",
    (date, bucket, blockages, zdate, zbucket, zblockages, negzQ,
     d, eid_client, ebucket, eblockages, id_client,
     g0, g1, g2, g3,
     zg0, zg1, zg2, zg3,
     wg0, wg1, wg2, wg3,
     yg0, yg1, yg2, yg3),
    (P, CDate, CBucket, CBlockages, V, Xdate, Xbucket, Xblockages,
     D, EncIdClient0, EncIdClient1, EncBucket0, EncBucket1,
     EncBlockages0, EncBlockages1,
     CG0, CG1, CG2, CG3,
     CG0sq, CG1sq, CG2sq, CG3sq),
    (A, B):
    // Blind showing of the Invitation credential
    CDate = (date*P + zdate*A),
    CBucket = (bucket*P + zbucket*A),
    CBlockages = (blockages*P + zblockages*A),
    // User blinding of the Lox credential to be issued
    D = (d*B),
    EncIdClient0 = (eid_client*B),
    EncIdClient1 = (id_client*B + eid_client*D),
    EncBucket0 = (ebucket*B),
    EncBucket1 = (bucket*B + ebucket*D),
    EncBlockages0 = (eblockages*B),
    EncBlockages1 = (blockages*B + eblockages*D),
    // Prove CDate encodes a value at most INVITATION_EXPIRY
    // days ago: first prove each of g0, ..., g3 is a bit by
    // proving that gi = gi^2
    CG0 = (g0*P + zg0*A), CG0sq = (g0*CG0 + wg0*A), CG0sq = (g0*P + yg0*A),
    CG1 = (g1*P + zg1*A), CG1sq = (g1*CG1 + wg1*A), CG1sq = (g1*P + yg1*A),
    CG2 = (g2*P + zg2*A), CG2sq = (g2*CG2 + wg2*A), CG2sq = (g2*P + yg2*A),
    CG3 = (g3*P + zg3*A), CG3sq = (g3*CG3 + wg3*A), CG3sq = (g3*P + yg3*A)
    // Then we'll check that today*P + CG0 + 2*CG1 + 4*CG2 + 8*CG3 =
    // CDate + INVITATION_EXPIRY*P by having the verifier
    // plug in CDate + INVITATION_EXPIRY*P - (today*P + 2*CG1 + 4*CG2
    // + 8*CG3) as its value of CG0.
}

define_proof! {
    blindissue,
    "Redeem Invite Issuing",
    (x0, x0tilde, xid, xbucket, xlevel, xsince, xblockages,
     s, b, tid, tbucket, tblockages),
    (P, EncQ0, EncQ1, X0, Xid, Xbucket, Xlevel, Xsince, Xblockages,
    Psince, TId, TBucket, TBlockages,
     D, EncId0, EncId1, EncBucket0, EncBucket1, EncBlockages0, EncBlockages1),
    (A, B):
    Xid = (xid*A),
    Xbucket = (xbucket*A),
    Xlevel = (xlevel*A),
    Xsince = (xsince*A),
    Xblockages = (xblockages*A),
    X0 = (x0*B + x0tilde*A),
    P = (b*B),
    TId = (b*Xid),
    TId = (tid*A),
    TBucket = (b*Xbucket),
    TBucket = (tbucket*A),
    TBlockages = (b*Xblockages),
    TBlockages = (tblockages*A),
    EncQ0 = (s*B + tid*EncId0 + tbucket*EncBucket0 + tblockages*EncBlockages0),
    // level=1 (so Plevel = P) and invremain=0 (so the term is omitted)
    EncQ1 = (s*D + tid*EncId1 + tbucket*EncBucket1
            + tblockages*EncBlockages1 + x0*P + xlevel*P + xsince*Psince)
}

pub fn request(
    inv_cred: &cred::Invitation,
    invitation_pub: &IssuerPubKey,
    today: u32,
) -> Result<(Request, State), CredentialError> {
    let A: &RistrettoPoint = &CMZ_A;
    let B: &RistrettoPoint = &CMZ_B;
    let Atable: &RistrettoBasepointTable = &CMZ_A_TABLE;
    let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

    // Ensure the credential can be correctly shown: it must be the case
    // that date + INVITATION_EXPIRY >= today.
    let date: u32 = match scalar_u32(&inv_cred.date) {
        Some(v) => v,
        None => {
            return Err(CredentialError::InvalidField(
                String::from("date"),
                String::from("could not be converted to u32"),
            ))
        }
    };
    if date + INVITATION_EXPIRY < today {
        return Err(CredentialError::CredentialExpired);
    }
    let diffdays = date + INVITATION_EXPIRY - today;
    // If diffdays > 15, then since INVITATION_EXPIRY <= 15, then date
    // must be in the future.  Reject.
    if diffdays > 15 {
        return Err(CredentialError::InvalidField(
            String::from("date"),
            String::from("credential was created in the future"),
        ));
    }

    // Blind showing the Invitation credential

    // Reblind P and Q
    let mut rng = rand::thread_rng();
    let t = Scalar::random(&mut rng);
    let P = t * inv_cred.P;
    let Q = t * inv_cred.Q;

    // Form Pedersen commitments to the blinded attributes
    let zdate = Scalar::random(&mut rng);
    let zbucket = Scalar::random(&mut rng);
    let zblockages = Scalar::random(&mut rng);
    let CDate = inv_cred.date * P + &zdate * Atable;
    let CBucket = inv_cred.bucket * P + &zbucket * Atable;
    let CBlockages = inv_cred.blockages * P + &zblockages * Atable;

    // Form a Pedersen commitment to the MAC Q
    // We flip the sign of zQ from that of the Hyphae paper so that
    // the ZKP has a "+" instead of a "-", as that's what the zkp
    // macro supports.
    let negzQ = Scalar::random(&mut rng);
    let CQ = Q - &negzQ * Atable;

    // Compute the "error factor"
    let V = zdate * invitation_pub.X[2]
        + zbucket * invitation_pub.X[3]
        + zblockages * invitation_pub.X[4]
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
    let EncBucket = (&ebucket * Btable, &inv_cred.bucket * Btable + ebucket * D);
    let eblockages = Scalar::random(&mut rng);
    let EncBlockages = (
        &eblockages * Btable,
        &inv_cred.blockages * Btable + eblockages * D,
    );

    // The range proof that 0 <= diffdays <= 15

    // Extract the 4 bits from diffdays
    let g0: Scalar = (diffdays & 1).into();
    let g1: Scalar = ((diffdays >> 1) & 1).into();
    let g2: Scalar = ((diffdays >> 2) & 1).into();
    let g3: Scalar = ((diffdays >> 3) & 1).into();

    // Pick random factors for the Pedersen commitments
    let wg0 = Scalar::random(&mut rng);
    let zg1 = Scalar::random(&mut rng);
    let wg1 = Scalar::random(&mut rng);
    let zg2 = Scalar::random(&mut rng);
    let wg2 = Scalar::random(&mut rng);
    let zg3 = Scalar::random(&mut rng);
    let wg3 = Scalar::random(&mut rng);

    // Compute zg0 to cancel things out as
    // zg0 = zdate - (2*zg1 + 4*zg2 + 8*zg3)
    // but use Horner's method
    let zg0 = zdate - scalar_dbl(&(scalar_dbl(&(scalar_dbl(&zg3) + zg2)) + zg1));

    let yg0 = wg0 + g0 * zg0;
    let yg1 = wg1 + g1 * zg1;
    let yg2 = wg2 + g2 * zg2;
    let yg3 = wg3 + g3 * zg3;

    let CG0 = g0 * P + &zg0 * Atable;
    let CG1 = g1 * P + &zg1 * Atable;
    let CG2 = g2 * P + &zg2 * Atable;
    let CG3 = g3 * P + &zg3 * Atable;

    let CG0sq = g0 * P + &yg0 * Atable;
    let CG1sq = g1 * P + &yg1 * Atable;
    let CG2sq = g2 * P + &yg2 * Atable;
    let CG3sq = g3 * P + &yg3 * Atable;

    // Construct the proof
    let mut transcript = Transcript::new(b"redeem invite request");
    let piUser = requestproof::prove_compact(
        &mut transcript,
        requestproof::ProveAssignments {
            A,
            B,
            P: &P,
            CDate: &CDate,
            CBucket: &CBucket,
            CBlockages: &CBlockages,
            V: &V,
            Xdate: &invitation_pub.X[2],
            Xbucket: &invitation_pub.X[3],
            Xblockages: &invitation_pub.X[4],
            D: &D,
            EncIdClient0: &EncIdClient.0,
            EncIdClient1: &EncIdClient.1,
            EncBucket0: &EncBucket.0,
            EncBucket1: &EncBucket.1,
            EncBlockages0: &EncBlockages.0,
            EncBlockages1: &EncBlockages.1,
            CG0: &CG0,
            CG1: &CG1,
            CG2: &CG2,
            CG3: &CG3,
            CG0sq: &CG0sq,
            CG1sq: &CG1sq,
            CG2sq: &CG2sq,
            CG3sq: &CG3sq,
            date: &inv_cred.date,
            bucket: &inv_cred.bucket,
            blockages: &inv_cred.blockages,
            zdate: &zdate,
            zbucket: &zbucket,
            zblockages: &zblockages,
            negzQ: &negzQ,
            d: &d,
            eid_client: &eid_client,
            ebucket: &ebucket,
            eblockages: &eblockages,
            id_client: &id_client,
            g0: &g0,
            g1: &g1,
            g2: &g2,
            g3: &g3,
            zg0: &zg0,
            zg1: &zg1,
            zg2: &zg2,
            zg3: &zg3,
            wg0: &wg0,
            wg1: &wg1,
            wg2: &wg2,
            wg3: &wg3,
            yg0: &yg0,
            yg1: &yg1,
            yg2: &yg2,
            yg3: &yg3,
        },
    )
    .0;

    Ok((
        Request {
            P,
            inv_id: inv_cred.inv_id,
            CDate,
            CBucket,
            CBlockages,
            CQ,
            D,
            EncIdClient,
            EncBucket,
            EncBlockages,
            CG1,
            CG2,
            CG3,
            CG0sq,
            CG1sq,
            CG2sq,
            CG3sq,
            piUser,
        },
        State {
            d,
            D,
            EncIdClient,
            EncBucket,
            EncBlockages,
            id_client,
            bucket: inv_cred.bucket,
            blockages: inv_cred.blockages,
        },
    ))
}

#[cfg(feature = "bridgeauth")]
impl BridgeAuth {
    /// Receive a redeem invite request
    pub fn handle_redeem_invite(&mut self, req: Request) -> Result<Response, ProofError> {
        let A: &RistrettoPoint = &CMZ_A;
        let B: &RistrettoPoint = &CMZ_B;
        let Atable: &RistrettoBasepointTable = &CMZ_A_TABLE;
        let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

        if req.P.is_identity() {
            return Err(ProofError::VerificationFailure);
        }

        let today: Scalar = self.today().into();

        // Recompute the "error factor" using knowledge of our own
        // (the issuer's) private key instead of knowledge of the
        // hidden attributes
        let Vprime = (self.invitation_priv.x[0] + self.invitation_priv.x[1] * req.inv_id) * req.P
            + self.invitation_priv.x[2] * req.CDate
            + self.invitation_priv.x[3] * req.CBucket
            + self.invitation_priv.x[4] * req.CBlockages
            - req.CQ;

        // Recompute CG0 using Horner's method
        let expiry: Scalar = INVITATION_EXPIRY.into();
        let CG0prime = (expiry - today) * req.P + req.CDate
            - pt_dbl(&(pt_dbl(&(pt_dbl(&req.CG3) + req.CG2)) + req.CG1));

        // Verify the ZKP
        let mut transcript = Transcript::new(b"redeem invite request");
        requestproof::verify_compact(
            &req.piUser,
            &mut transcript,
            requestproof::VerifyAssignments {
                A: &A.compress(),
                B: &B.compress(),
                P: &req.P.compress(),
                CDate: &req.CDate.compress(),
                CBucket: &req.CBucket.compress(),
                CBlockages: &req.CBlockages.compress(),
                V: &Vprime.compress(),
                Xdate: &self.invitation_pub.X[2].compress(),
                Xbucket: &self.invitation_pub.X[3].compress(),
                Xblockages: &self.invitation_pub.X[4].compress(),
                D: &req.D.compress(),
                EncIdClient0: &req.EncIdClient.0.compress(),
                EncIdClient1: &req.EncIdClient.1.compress(),
                EncBucket0: &req.EncBucket.0.compress(),
                EncBucket1: &req.EncBucket.1.compress(),
                EncBlockages0: &req.EncBlockages.0.compress(),
                EncBlockages1: &req.EncBlockages.1.compress(),
                CG0: &CG0prime.compress(),
                CG1: &req.CG1.compress(),
                CG2: &req.CG2.compress(),
                CG3: &req.CG3.compress(),
                CG0sq: &req.CG0sq.compress(),
                CG1sq: &req.CG1sq.compress(),
                CG2sq: &req.CG2sq.compress(),
                CG3sq: &req.CG3sq.compress(),
            },
        )?;

        // Ensure the id has not been seen before, and add it to the
        // invite id seen list.
        if self.inv_id_filter.filter(&req.inv_id) == SeenType::Seen {
            return Err(ProofError::VerificationFailure);
        }

        // Blind issuing of the new Lox credential

        // Choose a random server id component to add to the client's
        // (blinded) id component
        let mut rng = rand::thread_rng();
        let id_server = Scalar::random(&mut rng);
        let EncId = (req.EncIdClient.0, req.EncIdClient.1 + &id_server * Btable);

        // The trust level for invitees is always 1
        let level = Scalar::ONE;

        // The invites remaining for invitees is always 0 (as
        // appropriate for trust level 1), so we don't need to actually
        // construct it

        // Compute the MAC on the visible attributes
        let b = Scalar::random(&mut rng);
        let P = &b * Btable;
        let QHc =
            (self.lox_priv.x[0] + self.lox_priv.x[3] * level + self.lox_priv.x[4] * today) * P;

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
        let tblockages = self.lox_priv.x[6] * b;
        let TBlockages = &tblockages * Atable;
        let EncQBlockages = (
            tblockages * req.EncBlockages.0,
            tblockages * req.EncBlockages.1,
        );

        let EncQ = (
            EncQHc.0 + EncQId.0 + EncQBucket.0 + EncQBlockages.0,
            EncQHc.1 + EncQId.1 + EncQBucket.1 + EncQBlockages.1,
        );

        let mut transcript = Transcript::new(b"redeem invite issuing");
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
                Xblockages: &self.lox_pub.X[6],
                Psince: &(today * P),
                TId: &TId,
                TBucket: &TBucket,
                TBlockages: &TBlockages,
                D: &req.D,
                EncId0: &EncId.0,
                EncId1: &EncId.1,
                EncBucket0: &req.EncBucket.0,
                EncBucket1: &req.EncBucket.1,
                EncBlockages0: &req.EncBlockages.0,
                EncBlockages1: &req.EncBlockages.1,
                x0: &self.lox_priv.x[0],
                x0tilde: &self.lox_priv.x0tilde,
                xid: &self.lox_priv.x[1],
                xbucket: &self.lox_priv.x[2],
                xlevel: &self.lox_priv.x[3],
                xsince: &self.lox_priv.x[4],
                xblockages: &self.lox_priv.x[6],
                s: &s,
                b: &b,
                tid: &tid,
                tbucket: &tbucket,
                tblockages: &tblockages,
            },
        )
        .0;

        Ok(Response {
            P,
            EncQ,
            id_server,
            level_since: today,
            TId,
            TBucket,
            TBlockages,
            piBlindIssue,
        })
    }
}

/// Handle the response to the request, producing the new Lox credential
/// if successful.
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
    // and encrypted form
    let id = state.id_client + resp.id_server;
    let EncId = (
        state.EncIdClient.0,
        state.EncIdClient.1 + &resp.id_server * Btable,
    );

    // Verify the proof
    let mut transcript = Transcript::new(b"redeem invite issuing");
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
            Xblockages: &lox_pub.X[6].compress(),
            Psince: &(resp.level_since * resp.P).compress(),
            TId: &resp.TId.compress(),
            TBucket: &resp.TBucket.compress(),
            TBlockages: &resp.TBlockages.compress(),
            D: &state.D.compress(),
            EncId0: &EncId.0.compress(),
            EncId1: &EncId.1.compress(),
            EncBucket0: &state.EncBucket.0.compress(),
            EncBucket1: &state.EncBucket.1.compress(),
            EncBlockages0: &state.EncBlockages.0.compress(),
            EncBlockages1: &state.EncBlockages.1.compress(),
        },
    )?;

    // Decrypt EncQ
    let Q = resp.EncQ.1 - (state.d * resp.EncQ.0);

    Ok(cred::Lox {
        P: resp.P,
        Q,
        id,
        bucket: state.bucket,
        trust_level: Scalar::ONE,
        level_since: resp.level_since,
        invites_remaining: Scalar::ZERO,
        blockages: state.blockages,
    })
}
