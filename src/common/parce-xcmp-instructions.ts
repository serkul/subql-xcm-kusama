export function parceXcmpInstrustions(instructions, transfer) {
  instructions.forEach((instruction) => {
    Object.keys(instruction).forEach((key) => {
      switch (key) {
        case "WithdrawAsset":
          transfer.amount =
            instruction.WithdrawAsset[0].fun.Fungible.toString();
          transfer.assetId = JSON.stringify(instruction.WithdrawAsset[0].id);
          break;
        // case "BuyExecution":
        //   transfer.fees = JSON.stringify(instruction.BuyExecution);
        //   break;
        case "DepositAsset":
          transfer.toAddress =
            instruction.DepositAsset.beneficiary.interior.X1.AccountId32.id;
          break;
      }
    });
  });
}
