import { SubstrateExtrinsic, SubstrateEvent } from "@subql/types";
import { XCMTransfer } from "../types";
import { blake2AsU8a, blake2AsHex } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
// import { intrustionsFromBytesXCMP } from "../common/instructions-from-bytes-xcmp";
// import { parceXcmpInstrustions } from "../common/parce-xcmp-instructions";
// location when deploying
import { intrustionsFromBytesXCMP } from "./instructions-from-bytes-xcmp";
import { parceXcmpInstrustions } from "./parce-xcmp-instructions";

// Fill with all ids and move to separate file
const chainIDs = {
  Karura: "2000",
  Moonriver: "2023",
};

export async function handleDmpExtrinsic(
  extrinsic: SubstrateExtrinsic
): Promise<void> {
  const transfer = XCMTransfer.create({
    id: `${extrinsic.block.block.header.number.toNumber()}-${extrinsic.idx}`,
  });

  transfer.blockNumber = extrinsic.block.block.header.number.toBigInt();
  transfer.timestamp = extrinsic.block.timestamp.toISOString();
  const extrinsicAsAny = extrinsic.extrinsic as any;

  const {
    dest,
    beneficiary,
    assets,
    fee_asset_item: feeAsset,
    weight_limit: weightLimit,
  } = extrinsicAsAny.toHuman().method.args; //ts as any
  // transfer.warnings = JSON.stringify(extrinsicAsAny.toHuman(), undefined);
  transfer.toParachainId = dest.V1.interior.X1.Parachain.toString();
  transfer.toAddress = beneficiary.V1.interior.X1.AccountKey20.key.toString();
  transfer.assetId = assets.V0[0].ConcreteFungible.id.toString();
  transfer.amount = assets.V0[0].ConcreteFungible.amount.toString();
  // transfer.feeAsset = feeAsset.toString();
  // transfer.feeLimit = weightLimit.Limited.toString();

  const dmpQuery = await api.query.dmp.downwardMessageQueues(
    Number(transfer.toParachainId.replace(/,/g, ""))
  );
  transfer.xcmpMessageHash = blake2AsHex(Uint8Array.from(dmpQuery[0].msg));

  // Adhoc way to get fromAddress
  const withdrawEvents = extrinsic.events.filter(
    (el) => el.event.section == "balances" && el.event.method == "Withdraw"
  );

  withdrawEvents.forEach(({ event }) => {
    const eventAsAny = event as any;
    transfer.warnings = eventAsAny.toHuman().data.amount;
    if (eventAsAny.toHuman().data.amount === transfer.amount) {
      transfer.fromAddress = u8aToHex(Uint8Array.from(eventAsAny.data.who));
    }
  });
  await transfer.save();
}

export async function handleUmpExtrinsic(
  extrinsic: SubstrateExtrinsic
): Promise<void> {
  let foundUmp = false;
  let tempTransfer = {
    fromAddress: "",
    fromParachainId: "",

    toAddress: "",
    toParachainId: "",

    assetParachainId: "",
    assetId: "",
    amount: "",
    multiAssetJSON: "",

    xcmpMessageStatus: "", //change to union for threes statuses: sent, received, notfound
    xcmpMessageHash: "",
    xcmpInstructions: [],

    feesAssit: "",
    feeLimit: "",

    warnings: "",
  };
  const extrinsicAsAny = extrinsic.extrinsic as any;
  if (extrinsicAsAny.method.args[0].backedCandidates) {
    extrinsicAsAny.method.args[0].backedCandidates.forEach((candidate) => {
      const paraId = candidate.candidate.descriptor.paraId.toString();
      // // Check upward messages (from parachain to relay chain)
      candidate.candidate.commitments.upwardMessages.forEach((message) => {
        if (message.length > 0) {
          foundUmp = true;

          tempTransfer.xcmpMessageHash = blake2AsHex(Uint8Array.from(message));
          tempTransfer.fromParachainId = paraId;
          const instructionsHuman = intrustionsFromBytesXCMP(message, api);
          // // console.log(instructionsHuman);
          if (typeof instructionsHuman == "string") {
            tempTransfer.warnings += instructionsHuman;
          } else {
            tempTransfer.xcmpInstructions = instructionsHuman.map(
              (instruction) => JSON.stringify(instruction, undefined)
            );
            parceXcmpInstrustions(instructionsHuman, tempTransfer);
          }
        }
      });
    });
  }
  if (foundUmp) {
    const transfer = XCMTransfer.create({
      id: `${extrinsic.block.block.header.number.toBigInt()}-${extrinsic.idx}`,
    });

    transfer.blockNumber = extrinsic.block.block.header.number.toBigInt();
    transfer.timestamp = extrinsic.block.timestamp.toISOString();
    transfer.xcmpMessageHash = tempTransfer.xcmpMessageHash;
    transfer.fromParachainId = tempTransfer.fromParachainId;
    transfer.warnings = tempTransfer.warnings;
    transfer.xcmpInstructions = tempTransfer.xcmpInstructions;
    transfer.amount = tempTransfer.amount;
    transfer.assetId = tempTransfer.assetId;
    transfer.toAddress = tempTransfer.toAddress;

    await transfer.save();
  }
}
