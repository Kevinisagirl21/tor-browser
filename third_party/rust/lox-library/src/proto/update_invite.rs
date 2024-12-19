/*! A module for the protocol for a user to request the issuing of an updated
 * invitation credential after a key rotation has occurred


The user presents their current Invitation credential:
- id: revealed
- date: blinded
- bucket: blinded
- blockages: blinded

and a new Invitation credential to be issued:
- id: jointly chosen by the user and BA
- date: blinded, but proved in ZK that it's the same as in the invitation
  date above
- bucket: blinded, but proved in ZK that it's the same as in the Invitation
  credential above
- blockages: blinded, but proved in ZK that it's the same as in the
  Invitation credential above

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
    // Fields for showing the old Invitation credential
    OldPubKey: IssuerPubKey,
    P: RistrettoPoint,
    inv_id: Scalar,
    CDate: RistrettoPoint,
    CBucket: RistrettoPoint,
    CBlockages: RistrettoPoint,
    CQ: RistrettoPoint,

    // Fields for user blinding of the Invitation credential to be updated
    D: RistrettoPoint,
    EncInvIdClient: (RistrettoPoint, RistrettoPoint),
    EncDate: (RistrettoPoint, RistrettoPoint),
    EncBucket: (RistrettoPoint, RistrettoPoint),
    EncBlockages: (RistrettoPoint, RistrettoPoint),

    // The combined ZKP
    piUser: CompactProof,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct State {
    d: Scalar,
    D: RistrettoPoint,
    EncInvIdClient: (RistrettoPoint, RistrettoPoint),
    EncDate: (RistrettoPoint, RistrettoPoint),
    EncBucket: (RistrettoPoint, RistrettoPoint),
    EncBlockages: (RistrettoPoint, RistrettoPoint),
    inv_id_client: Scalar,
    date: Scalar,
    bucket: Scalar,
    blockages: Scalar,
}

#[derive(Serialize, Deserialize)]
pub struct Response {
    // The fields for the updated Invitation credential;
    P: RistrettoPoint,
    EncQ: (RistrettoPoint, RistrettoPoint),
    inv_id_server: Scalar,
    TInvId: RistrettoPoint,
    TDate: RistrettoPoint,
    TBucket: RistrettoPoint,
    TBlockages: RistrettoPoint,

    // The ZKP
    piBlindIssue: CompactProof,
}

define_proof! {
    requestproof,
    "Update Invite Request",
    (date, bucket, blockages, zdate, zbucket, zblockages, negzQ,
     d, einv_id_client, edate, ebucket, eblockages, inv_id_client),
    (P, CDate, CBucket, CBlockages, V, Xdate, Xbucket, Xblockages,
     D, EncInvIdClient0, EncInvIdClient1, EncDate0, EncDate1, EncBucket0, EncBucket1,
     EncBlockages0, EncBlockages1),
    (A, B):
    // Blind showing of the Invitation credential
    CDate = (date*P + zdate*A),
    CBucket = (bucket*P + zbucket*A),
    CBlockages = (blockages*P + zblockages*A),
    // User blinding of the Invitation credential to be issued
    D = (d*B),
    EncInvIdClient0 = (einv_id_client*B),
    EncInvIdClient1 = (inv_id_client*B + einv_id_client*D),
    EncDate0 = (edate*B),
    EncDate1 = (date*B + edate*D),
    EncBucket0 = (ebucket*B),
    EncBucket1 = (bucket*B + ebucket*D),
    EncBlockages0 = (eblockages*B),
    EncBlockages1 = (blockages*B + eblockages*D)
}

define_proof! {
    blindissue,
    "Issue Updated Invitation",
    (x0, x0tilde, xinv_id, xdate, xbucket, xblockages,
     s, b, tinv_id, tdate, tbucket, tblockages),
    (P, EncQ0, EncQ1, X0, Xinv_id, Xdate, Xbucket, Xblockages,
        TInvId, TDate, TBucket, TBlockages,
     D, EncInvId0, EncInvId1, EncDate0, EncDate1, EncBucket0, EncBucket1, EncBlockages0, EncBlockages1),
    (A, B):
    Xinv_id = (xinv_id*A),
    Xdate = (xdate*A),
    Xbucket = (xbucket*A),
    Xblockages = (xblockages*A),
    X0 = (x0*B + x0tilde*A),
    P = (b*B),
    TInvId = (b*Xinv_id),
    TInvId = (tinv_id*A),
    TDate = (b*Xdate),
    TDate = (tdate*A),
    TBucket = (b*Xbucket),
    TBucket = (tbucket*A),
    TBlockages = (b*Xblockages),
    TBlockages = (tblockages*A),
    EncQ0 = (s*B + tinv_id*EncInvId0 + tdate*EncDate0 + tbucket*EncBucket0 + tblockages*EncBlockages0),
    EncQ1 = (s*D + tinv_id*EncInvId1  + tdate*EncDate1 + tbucket*EncBucket1
            + tblockages*EncBlockages1 + x0*P)
}

pub fn request(
    inv_cred: &cred::Invitation,
    invitation_pub: &IssuerPubKey,
) -> Result<(Request, State), CredentialError> {
    let A: &RistrettoPoint = &CMZ_A;
    let B: &RistrettoPoint = &CMZ_B;
    let Atable: &RistrettoBasepointTable = &CMZ_A_TABLE;
    let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

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

    // User blinding for the Invitation Token to be issued

    // Pick an ElGamal keypair
    let d = Scalar::random(&mut rng);
    let D = &d * Btable;

    // Pick a random client component of the id
    let inv_id_client = Scalar::random(&mut rng);

    // Encrypt it (times the basepoint B) to the ElGamal public key D we
    // just created
    let einv_id_client = Scalar::random(&mut rng);
    let EncInvIdClient = (
        &einv_id_client * Btable,
        &inv_id_client * Btable + einv_id_client * D,
    );

    // Encrypt the other blinded fields (times B) to D as well
    let edate = Scalar::random(&mut rng);
    let EncDate = (&edate * Btable, &inv_cred.date * Btable + edate * D);
    let ebucket = Scalar::random(&mut rng);
    let EncBucket = (&ebucket * Btable, &inv_cred.bucket * Btable + ebucket * D);
    let eblockages = Scalar::random(&mut rng);
    let EncBlockages = (
        &eblockages * Btable,
        &inv_cred.blockages * Btable + eblockages * D,
    );

    // Construct the proof
    let mut transcript = Transcript::new(b"update invite request");
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
            EncInvIdClient0: &EncInvIdClient.0,
            EncInvIdClient1: &EncInvIdClient.1,
            EncDate0: &EncDate.0,
            EncDate1: &EncDate.1,
            EncBucket0: &EncBucket.0,
            EncBucket1: &EncBucket.1,
            EncBlockages0: &EncBlockages.0,
            EncBlockages1: &EncBlockages.1,
            date: &inv_cred.date,
            bucket: &inv_cred.bucket,
            blockages: &inv_cred.blockages,
            zdate: &zdate,
            zbucket: &zbucket,
            zblockages: &zblockages,
            negzQ: &negzQ,
            d: &d,
            einv_id_client: &einv_id_client,
            edate: &edate,
            ebucket: &ebucket,
            eblockages: &eblockages,
            inv_id_client: &inv_id_client,
        },
    )
    .0;

    Ok((
        Request {
            OldPubKey: invitation_pub.clone(),
            P,
            inv_id: inv_cred.inv_id,
            CDate,
            CBucket,
            CBlockages,
            CQ,
            D,
            EncInvIdClient,
            EncDate,
            EncBucket,
            EncBlockages,
            piUser,
        },
        State {
            d,
            D,
            EncInvIdClient,
            EncDate,
            EncBucket,
            EncBlockages,
            inv_id_client,
            date: inv_cred.date,
            bucket: inv_cred.bucket,
            blockages: inv_cred.blockages,
        },
    ))
}

#[cfg(feature = "bridgeauth")]
impl BridgeAuth {
    /// Receive a redeem invite request
    pub fn handle_update_invite(&mut self, req: Request) -> Result<Response, ProofError> {
        let A: &RistrettoPoint = &CMZ_A;
        let B: &RistrettoPoint = &CMZ_B;
        let Atable: &RistrettoBasepointTable = &CMZ_A_TABLE;
        let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

        if req.P.is_identity() {
            return Err(ProofError::VerificationFailure);
        }

        // Both of these must be true and should be true after rotate_lox_keys is called
        if self.old_keys.invitation_keys.is_empty() || self.old_filters.invitation_filter.is_empty()
        {
            return Err(ProofError::VerificationFailure);
        }

        // calling this function will automatically use the most recent old private key for
        // verification and the new private key for issuing.

        // Recompute the "error factors" using knowledge of our own
        // (the issuer's) outdated private key instead of knowledge of the
        // hidden attributes
        let old_keys = match self
            .old_keys
            .invitation_keys
            .iter()
            .find(|x| x.pub_key == req.OldPubKey)
        {
            Some(old_keys) => old_keys,
            None => return Err(ProofError::VerificationFailure),
        };
        let index = self
            .old_keys
            .invitation_keys
            .iter()
            .position(|x| x.pub_key == old_keys.pub_key)
            .unwrap();
        let old_priv_key = old_keys.priv_key.clone();
        let old_pub_key = old_keys.pub_key.clone();

        // Recompute the "error factor" using knowledge of our own
        // (the issuer's) private key instead of knowledge of the
        // hidden attributes
        let Vprime = (old_priv_key.x[0] + old_priv_key.x[1] * req.inv_id) * req.P
            + old_priv_key.x[2] * req.CDate
            + old_priv_key.x[3] * req.CBucket
            + old_priv_key.x[4] * req.CBlockages
            - req.CQ;

        // Verify the ZKP
        let mut transcript = Transcript::new(b"update invite request");
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
                Xdate: &old_pub_key.X[2].compress(),
                Xbucket: &old_pub_key.X[3].compress(),
                Xblockages: &old_pub_key.X[4].compress(),
                D: &req.D.compress(),
                EncInvIdClient0: &req.EncInvIdClient.0.compress(),
                EncInvIdClient1: &req.EncInvIdClient.1.compress(),
                EncDate0: &req.EncDate.0.compress(),
                EncDate1: &req.EncDate.1.compress(),
                EncBucket0: &req.EncBucket.0.compress(),
                EncBucket1: &req.EncBucket.1.compress(),
                EncBlockages0: &req.EncBlockages.0.compress(),
                EncBlockages1: &req.EncBlockages.1.compress(),
            },
        )?;

        // Ensure the id has not been seen before, and add it to the
        // invite id seen list.
        if self
            .old_filters
            .invitation_filter
            .get_mut(index)
            .unwrap()
            .filter(&req.inv_id)
            == SeenType::Seen
        {
            return Err(ProofError::VerificationFailure);
        }

        // Blind issuing of the new Invitation credential

        // Choose a random server id component to add to the client's
        // (blinded) id component
        let mut rng = rand::thread_rng();
        let inv_id_server = Scalar::random(&mut rng);
        let EncInvId = (
            req.EncInvIdClient.0,
            req.EncInvIdClient.1 + &inv_id_server * Btable,
        );

        // Compute the MAC on the visible attributes
        let b = Scalar::random(&mut rng);
        let P = &b * Btable;
        let QHc = self.invitation_priv.x[0] * P;

        // El Gamal encrypt it to the public key req.D
        let s = Scalar::random(&mut rng);
        let EncQHc = (&s * Btable, QHc + s * req.D);

        // Homomorphically compute the part of the MAC corresponding to
        // the blinded attributes
        let tinv_id = self.invitation_priv.x[1] * b;
        let TInvId = &tinv_id * Atable;
        let EncQId = (tinv_id * EncInvId.0, tinv_id * EncInvId.1);
        let tdate = self.invitation_priv.x[2] * b;
        let TDate = &tdate * Atable;
        let EncQDate = (tdate * req.EncDate.0, tdate * req.EncDate.1);
        let tbucket = self.invitation_priv.x[3] * b;
        let TBucket = &tbucket * Atable;
        let EncQBucket = (tbucket * req.EncBucket.0, tbucket * req.EncBucket.1);
        let tblockages = self.invitation_priv.x[4] * b;
        let TBlockages = &tblockages * Atable;
        let EncQBlockages = (
            tblockages * req.EncBlockages.0,
            tblockages * req.EncBlockages.1,
        );

        let EncQ = (
            EncQHc.0 + EncQId.0 + EncQDate.0 + EncQBucket.0 + EncQBlockages.0,
            EncQHc.1 + EncQId.1 + EncQDate.1 + EncQBucket.1 + EncQBlockages.1,
        );

        let mut transcript = Transcript::new(b"issue updated invitation");
        let piBlindIssue = blindissue::prove_compact(
            &mut transcript,
            blindissue::ProveAssignments {
                A,
                B,
                P: &P,
                EncQ0: &EncQ.0,
                EncQ1: &EncQ.1,
                X0: &self.invitation_pub.X[0],
                Xinv_id: &self.invitation_pub.X[1],
                Xdate: &self.invitation_pub.X[2],
                Xbucket: &self.invitation_pub.X[3],
                Xblockages: &self.invitation_pub.X[4],
                TInvId: &TInvId,
                TDate: &TDate,
                TBucket: &TBucket,
                TBlockages: &TBlockages,
                D: &req.D,
                EncInvId0: &EncInvId.0,
                EncInvId1: &EncInvId.1,
                EncDate0: &req.EncDate.0,
                EncDate1: &req.EncDate.1,
                EncBucket0: &req.EncBucket.0,
                EncBucket1: &req.EncBucket.1,
                EncBlockages0: &req.EncBlockages.0,
                EncBlockages1: &req.EncBlockages.1,
                x0: &self.invitation_priv.x[0],
                x0tilde: &self.invitation_priv.x0tilde,
                xinv_id: &self.invitation_priv.x[1],
                xdate: &self.invitation_priv.x[2],
                xbucket: &self.invitation_priv.x[3],
                xblockages: &self.invitation_priv.x[4],
                s: &s,
                b: &b,
                tinv_id: &tinv_id,
                tdate: &tdate,
                tbucket: &tbucket,
                tblockages: &tblockages,
            },
        )
        .0;

        Ok(Response {
            P,
            EncQ,
            inv_id_server,
            TInvId,
            TDate,
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
    invitation_pub: &IssuerPubKey,
) -> Result<cred::Invitation, ProofError> {
    let A: &RistrettoPoint = &CMZ_A;
    let B: &RistrettoPoint = &CMZ_B;
    let Btable: &RistrettoBasepointTable = &CMZ_B_TABLE;

    if resp.P.is_identity() {
        return Err(ProofError::VerificationFailure);
    }
    // Add the server's contribution to the id to our own, both in plain
    // and encrypted form
    let inv_id = state.inv_id_client + resp.inv_id_server;
    let EncInvId = (
        state.EncInvIdClient.0,
        state.EncInvIdClient.1 + &resp.inv_id_server * Btable,
    );

    // Verify the proof
    let mut transcript = Transcript::new(b"issue updated invitation");
    blindissue::verify_compact(
        &resp.piBlindIssue,
        &mut transcript,
        blindissue::VerifyAssignments {
            A: &A.compress(),
            B: &B.compress(),
            P: &resp.P.compress(),
            EncQ0: &resp.EncQ.0.compress(),
            EncQ1: &resp.EncQ.1.compress(),
            X0: &invitation_pub.X[0].compress(),
            Xinv_id: &invitation_pub.X[1].compress(),
            Xdate: &invitation_pub.X[2].compress(),
            Xbucket: &invitation_pub.X[3].compress(),
            Xblockages: &invitation_pub.X[4].compress(),
            TInvId: &resp.TInvId.compress(),
            TDate: &resp.TDate.compress(),
            TBucket: &resp.TBucket.compress(),
            TBlockages: &resp.TBlockages.compress(),
            D: &state.D.compress(),
            EncInvId0: &EncInvId.0.compress(),
            EncInvId1: &EncInvId.1.compress(),
            EncDate0: &state.EncDate.0.compress(),
            EncDate1: &state.EncDate.1.compress(),
            EncBucket0: &state.EncBucket.0.compress(),
            EncBucket1: &state.EncBucket.1.compress(),
            EncBlockages0: &state.EncBlockages.0.compress(),
            EncBlockages1: &state.EncBlockages.1.compress(),
        },
    )?;

    // Decrypt EncQ
    let Q = resp.EncQ.1 - (state.d * resp.EncQ.0);

    Ok(cred::Invitation {
        P: resp.P,
        Q,
        inv_id,
        date: state.date,
        bucket: state.bucket,
        blockages: state.blockages,
    })
}
