import { SubstrateExtrinsic, SubstrateEvent } from "@subql/types";
import { XCMTransfer } from "../types";
import {
  blake2AsU8a,
  blake2AsHex,
  decodeAddress,
  encodeAddress,
  evmToAddress,
} from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { intructionsFromXcmU8Array } from "../common/instructions-from-xcmp-msg-u8array";
import { parceXcmpInstrustions } from "../common/parce-xcmp-instructions";
import { getSS58AddressForChain } from "../common/get-ss58-address";
import { TextEncoder } from "@polkadot/x-textencoder";
import { parceInterior } from "../common/parce-interior";

export async function handleDmpExtrinsic(
  extrinsic: SubstrateExtrinsic
): Promise<void> {
  const transfer = XCMTransfer.create({
    id: `${extrinsic.block.block.header.number.toNumber()}-${extrinsic.idx}`,
    warnings: "",
    assetId: [],
    amount: [],
    toAddress: "",
    toParachainId: "",
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
  // transfer.toParachainId = dest.V1.interior.X1.Parachain.replace(/,/g, "");
  // transfer.toAddress = beneficiary.V1.interior.X1.AccountKey20.key.toString();
  // Extract destination chain ID and address from XcmpMultilocation
  const parceInterioRes = parceInterior(dest.interior);
  if (typeof parceInterioRes == "string") {
    transfer.warnings += parceInterioRes;
  } else {
    [transfer.toParachainId, transfer.toAddress] = parceInterioRes;
  }
  transfer.assetId = assets.V0[0].ConcreteFungible.id.toString();
  transfer.amount = assets.V0[0].ConcreteFungible.amount.replace(/,/g, "");
  transfer.xcmpMessageStatus = "DMP sent";

  const dmpQuery = await api.query.dmp.downwardMessageQueues(
    Number(transfer.toParachainId.replace(/,/g, ""))
  );
  transfer.xcmpMessageHash = blake2AsHex(Uint8Array.from(dmpQuery[0].msg));

  transfer.fromParachainId = "0"; //dmp sends always from kusama
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

  // calculate SS58 addresses for given chains
  const [ansFrom, addressFrom] = getSS58AddressForChain(
    transfer.fromAddress,
    transfer.fromParachainId
  );
  if (ansFrom) {
    transfer.fromAddressSS58 = addressFrom;
  } else {
    transfer.warnings += addressFrom;
  }

  const [ansTo, addressTo] = getSS58AddressForChain(
    transfer.toAddress,
    transfer.toParachainId
  );
  if (ansTo) {
    transfer.toAddressSS58 = addressTo;
  } else {
    transfer.warnings += addressTo;
  }

  await transfer.save();
}

export async function handleUmpExtrinsic(
  extrinsic: SubstrateExtrinsic
): Promise<void> {
  let foundUmp = false;
  let tempTransfer = {
    fromAddress: "",
    fromAddressSS58: "",
    fromParachainId: "",

    toAddress: "",
    toAddressSS58: "",
    toParachainId: "",

    assetId: [],
    amount: [],
    assetIdTransferred: [],
    amountTransferred: [],

    xcmpMessageHash: "",
    xcmpMessageStatus: "",
    xcmpTransferStatus: [],
    xcmpInstructions: [],

    warnings: "",
  };
  const extrinsicAsAny = extrinsic.extrinsic as any;
  if (extrinsicAsAny.method.args[0].backedCandidates) {
    extrinsicAsAny.method.args[0].backedCandidates.forEach((candidate) => {
      const paraId = candidate.candidate.descriptor.paraId
        .toString()
        .replace(/,/g, "");
      // // Check upward messages (from parachain to relay chain)
      candidate.candidate.commitments.upwardMessages.forEach((message) => {
        if (message.length > 0) {
          foundUmp = true;

          tempTransfer.xcmpMessageHash = blake2AsHex(Uint8Array.from(message));
          tempTransfer.fromParachainId = paraId;
          const instructionsHuman = intructionsFromXcmU8Array(message, api);

          if (typeof instructionsHuman == "string") {
            tempTransfer.warnings += instructionsHuman;
          } else {
            tempTransfer.xcmpInstructions = instructionsHuman.map(
              (instruction) => JSON.stringify(instruction, undefined)
            );
            parceXcmpInstrustions(instructionsHuman, tempTransfer);

            // Calculate SS58 version of address
            const [ans, address] = getSS58AddressForChain(
              tempTransfer.toAddress,
              tempTransfer.toParachainId
            );
            if (ans) {
              tempTransfer.toAddressSS58 = address;
            } else {
              tempTransfer.warnings += address;
            }

            // calculate "custom" UMP hash, since parachain side
            // doesn't knows the "real" XCMP hash
            tempTransfer.xcmpMessageHash = calcCustomUmpHash(instructionsHuman);

            // // Find and parce assets.Issued event to confirm assets transder
            // // and get the final amount deposited
            // const depositEvents = extrinsic.block.events.forEach(
            //   (el) =>
            //     el.event.section == "balances" && el.event.method == "Deposit"
            // ) as any;
            // depositEvents.forEach(({ event }) => {
            //   if (event.toHuman().data.owner == tempTransfer.toAddressSS58) {
            //     tempTransfer.xcmpTransferStatus.push("");
            //     transfer.amountTransferred.push(event.toHuman().data.totalSupply);
            //     transfer.assetIdTransferred.push(event.toHuman().data.assetId);
            //   }
            // });
          }
        }
      });
    });
  }
  if (foundUmp) {
    const transfer = XCMTransfer.create({
      id: `${extrinsic.block.block.header.number.toBigInt()}-${extrinsic.idx}`,
      blockNumber: extrinsic.block.block.header.number.toBigInt(),
      timestamp: extrinsic.block.timestamp.toISOString(),
      // fromAddress:
      // fromAddressSS58:
      fromParachainId: tempTransfer.fromParachainId,
      toAddress: tempTransfer.toAddress,
      toAddressSS58: tempTransfer.toAddressSS58,
      toParachainId: tempTransfer.toParachainId,
      assetId: tempTransfer.assetId,
      amount: tempTransfer.amount,
      // assetIdTransferred:
      // amountTransferred:
      xcmpMessageHash: tempTransfer.xcmpMessageHash,
      xcmpMessageStatus: "UMP received",
      // xcmpTransferStatus:
      xcmpInstructions: tempTransfer.xcmpInstructions,
      warnings: tempTransfer.warnings,
    });
    await transfer.save();
  }
}

function calcCustomUmpHash(instructions) {
  // Function computes Blake2 hash bashe on the given Multilocation and amount
  let amountAsU8Array;
  let destAsAsU8Array;
  instructions.slice(1).forEach((instruction) => {
    Object.keys(instruction).forEach((key) => {
      if (key == "WithdrawAsset") {
        amountAsU8Array = new TextEncoder().encode(
          instruction.WithdrawAsset[0].fun.Fungible
        );
      }
      if (key == "DepositAsset") {
        destAsAsU8Array = new TextEncoder().encode(
          JSON.stringify(
            instruction.DepositAsset.beneficiary.interior,
            undefined,
            0
          )
        );
      }
    });
  });
  const customUpmHash = blake2AsHex(
    new Uint8Array([...amountAsU8Array, ...destAsAsU8Array])
  );

  return customUpmHash;
}
