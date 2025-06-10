const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("----------------Xescrow---------------- EXTENSIVE TESTS for The Cookathon of Mantle Network", function () {
  let xescrow;
  let owner, client, provider, juror1, juror2;
  const ROLE_PROVIDER = 2; 
  const ROLE_CLIENT = 1; 
  const ROLE_JURADO = 3; 
  const OFFER_STATUS_OPEN = 0;
  const OFFER_STATUS_ACCEPTED = 1;
  const OFFER_STATUS_DISPUTED = 4; 
  const OFFER_STATUS_RESOLVED = 5;

  beforeEach(async function () {
    [owner, client, provider, juror1, juror2] = await ethers.getSigners();
    const Xescrow = await ethers.getContractFactory("Xescrow");
    xescrow = await Xescrow.deploy();
    await xescrow.waitForDeployment();
  });

  describe("User Registration", function () {
    it("Should register users with valid roles and emit event", async function () {
      await expect(xescrow.connect(client).registerUser(ROLE_CLIENT))
        .to.emit(xescrow, "UserRegistered")
        .withArgs(client.address, ROLE_CLIENT);
      const user = await xescrow.users(client.address);
      expect(user.role).to.equal(ROLE_CLIENT);
      expect(user.registered).to.be.true;
    });

    it("Should reject registration with invalid role", async function () {
      await expect(xescrow.connect(client).registerUser(0)).to.be.revertedWith("Invalid role");
    });

    it("Should reject registration if already registered", async function () {
      await xescrow.connect(client).registerUser(ROLE_CLIENT);
      await expect(xescrow.connect(client).registerUser(ROLE_CLIENT)).to.be.revertedWith("Already registered");
    });
  });

  describe("Offer Creation", function () {
    beforeEach(async function () {
      await xescrow.connect(provider).registerUser(ROLE_PROVIDER);
    });

    it("Should create offer and emit event", async function () {
      const price = ethers.parseEther("1");
      await expect(xescrow.connect(provider).createServiceOffer("descHash", price, 3600))
        .to.emit(xescrow, "OfferCreated")
        .withArgs(0, provider.address, price, "descHash");
      const offer = await xescrow.offers(0);
      expect(offer.provider).to.equal(provider.address);
      expect(offer.price).to.equal(price);
      expect(offer.status).to.equal(OFFER_STATUS_OPEN);
    });

    it("Should reject creation with zero price", async function () {
      await expect(xescrow.connect(provider).createServiceOffer("descHash", 0, 3600)).to.be.revertedWith("Price must be > 0");
    });

    it("Should reject creation by non-Provider", async function () {
      await xescrow.connect(client).registerUser(ROLE_CLIENT);
      await expect(xescrow.connect(client).createServiceOffer("descHash", ethers.parseEther("1"), 3600)).to.be.revertedWith("Only providers");
    });
  });

  describe("Offer Acceptance", function () {
    beforeEach(async function () {
      await xescrow.connect(provider).registerUser(ROLE_PROVIDER);
      await xescrow.connect(client).registerUser(ROLE_CLIENT);
      await xescrow.connect(provider).createServiceOffer("descHash", ethers.parseEther("1"), 3600);
    });

    it("Should accept offer and emit event", async function () {
      await expect(xescrow.connect(client).acceptOffer(0, { value: ethers.parseEther("1") }))
        .to.emit(xescrow, "OfferAccepted")
        .withArgs(0, client.address);
      const offer = await xescrow.offers(0);
      expect(offer.client).to.equal(client.address);
      expect(offer.status).to.equal(OFFER_STATUS_ACCEPTED);
      expect(offer.acceptedAt).to.be.gt(0);
    });

    it("Should reject acceptance with incorrect payment", async function () {
      await expect(xescrow.connect(client).acceptOffer(0, { value: ethers.parseEther("0.5") })).to.be.revertedWith("Incorrect payment");
    });

    it("Should reject acceptance by non-Client", async function () {
      await xescrow.connect(juror1).registerUser(ROLE_JURADO);
      await expect(xescrow.connect(juror1).acceptOffer(0, { value: ethers.parseEther("1") })).to.be.revertedWith("Only clients");
    });
  });

  describe("Proof of Delivery Submission", function () {
    beforeEach(async function () {
      await xescrow.connect(provider).registerUser(ROLE_PROVIDER);
      await xescrow.connect(client).registerUser(ROLE_CLIENT);
      await xescrow.connect(provider).createServiceOffer("descHash", ethers.parseEther("1"), 3600);
      await xescrow.connect(client).acceptOffer(0, { value: ethers.parseEther("1") });
    });

    it("Should submit proof of delivery and emit event", async function () {
      await expect(xescrow.connect(provider).submitProofOfDelivery(0, "proofHash", "comment"))
        .to.emit(xescrow, "ProofSubmitted")
        .withArgs(0, "proofHash", "comment");
      const offer = await xescrow.offers(0);
      expect(offer.deliveryProofHash).to.equal("proofHash");
    });

    it("Should reject submission by non-Provider", async function () {
      await expect(xescrow.connect(client).submitProofOfDelivery(0, "proofHash", "comment")).to.be.revertedWith("Only provider");
    });

    it("Should reject submission without proof", async function () {
      await expect(xescrow.connect(provider).submitProofOfDelivery(0, "", "comment")).to.be.revertedWith("Proof required");
    });
  });

  describe("Delivery Confirmation", function () {
    beforeEach(async function () {
      await xescrow.connect(provider).registerUser(ROLE_PROVIDER);
      await xescrow.connect(client).registerUser(ROLE_CLIENT);
      await xescrow.connect(provider).createServiceOffer("descHash", ethers.parseEther("1"), 3600);
      await xescrow.connect(client).acceptOffer(0, { value: ethers.parseEther("1") });
      await xescrow.connect(provider).submitProofOfDelivery(0, "proofHash", "comment");
    });

    it("Should confirm delivery and emit event", async function () {
      await expect(xescrow.connect(client).confirmDelivery(0))
        .to.emit(xescrow, "DeliveryConfirmed")
        .withArgs(0);
      const offer = await xescrow.offers(0);
      expect(offer.status).to.equal(2); 
      expect(await xescrow.pendingWithdrawals(provider.address)).to.equal(ethers.parseEther("0.98"));
      expect(await xescrow.platformFees()).to.equal(ethers.parseEther("0.02"));
    });

    it("Should reject confirmation by non-Client", async function () {
      await expect(xescrow.connect(provider).confirmDelivery(0)).to.be.revertedWith("Only client");
    });

    it("Should reject confirmation after timeout", async function () {
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine");
      await expect(xescrow.connect(client).confirmDelivery(0)).to.be.revertedWith("Delivery timeout");
    });
  });

  describe("Disputes and Voting", function () {
    beforeEach(async function () {
      await xescrow.connect(provider).registerUser(ROLE_PROVIDER);
      await xescrow.connect(client).registerUser(ROLE_CLIENT);
      await xescrow.connect(juror1).registerUser(ROLE_JURADO);
      await xescrow.connect(juror2).registerUser(ROLE_JURADO);
      await xescrow.connect(provider).createServiceOffer("descHash", ethers.parseEther("1"), 3600);
      await xescrow.connect(client).acceptOffer(0, { value: ethers.parseEther("1") });
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine");
    });

    it("Should initiate dispute and emit event", async function () {
      const offerBefore = await xescrow.offers(0);
      expect(offerBefore.status).to.equal(OFFER_STATUS_ACCEPTED);
      expect(offerBefore.acceptedAt).to.be.gt(0);
      const currentTime = await ethers.provider.getBlock("latest").then(block => block.timestamp);
      expect(currentTime).to.be.gt(offerBefore.acceptedAt + offerBefore.deliveryTimeout);

      await expect(xescrow.connect(client).disputeOffer(0))
        .to.emit(xescrow, "OfferDisputed")
        .withArgs(0);

      const offerAfter = await xescrow.offers(0);
      expect(offerAfter.status).to.equal(OFFER_STATUS_DISPUTED);
    });

    it("Should allow voting and emit events", async function () {
      await xescrow.connect(client).disputeOffer(0);
      await expect(xescrow.connect(juror1).voteDispute(0, client.address))
        .to.emit(xescrow, "VoteCast")
        .withArgs(0, juror1.address, client.address);
      await expect(xescrow.connect(juror2).voteDispute(0, client.address))
        .to.emit(xescrow, "DisputeResolved")
        .withArgs(0, client.address);
      const offer = await xescrow.offers(0);
      expect(offer.status).to.equal(OFFER_STATUS_RESOLVED);
    });

    it("Should distribute funds after resolution", async function () {
      await xescrow.connect(client).disputeOffer(0);
      await xescrow.connect(juror1).voteDispute(0, client.address);
      await xescrow.connect(juror2).voteDispute(0, client.address);
      expect(await xescrow.pendingWithdrawals(client.address)).to.equal(ethers.parseEther("0.88"));
      expect(await xescrow.pendingWithdrawals(juror1.address)).to.equal(ethers.parseEther("0.05"));
      expect(await xescrow.platformFees()).to.equal(ethers.parseEther("0.02"));
    });
  });

  describe("Offer Cancellation", function () {
    beforeEach(async function () {
      await xescrow.connect(provider).registerUser(ROLE_PROVIDER);
      await xescrow.connect(client).registerUser(ROLE_CLIENT); 
      await xescrow.connect(provider).createServiceOffer("descHash", ethers.parseEther("1"), 3600);
    });

    it("Should cancel offer and emit event", async function () {
      await expect(xescrow.connect(provider).cancelOffer(0))
        .to.emit(xescrow, "OfferCancelled")
        .withArgs(0);
      const offer = await xescrow.offers(0);
      expect(offer.status).to.equal(3); 
    });

    it("Should reject cancellation by non-Provider", async function () {
      await expect(xescrow.connect(client).cancelOffer(0)).to.be.revertedWith("Only provider");
    });
  });

  describe("Funds Withdrawal", function () {
    beforeEach(async function () {
      await xescrow.connect(provider).registerUser(ROLE_PROVIDER);
      await xescrow.connect(client).registerUser(ROLE_CLIENT);
      await xescrow.connect(provider).createServiceOffer("descHash", ethers.parseEther("1"), 3600);
      await xescrow.connect(client).acceptOffer(0, { value: ethers.parseEther("1") });
      await xescrow.connect(provider).submitProofOfDelivery(0, "proofHash", "comment");
      await xescrow.connect(client).confirmDelivery(0);
    });

    it("Should withdraw funds and emit event", async function () {
      await expect(xescrow.connect(provider).withdrawFunds())
        .to.emit(xescrow, "FundsWithdrawn")
        .withArgs(provider.address, ethers.parseEther("0.98"));
      expect(await xescrow.pendingWithdrawals(provider.address)).to.equal(0);
    });
  });

  describe("Platform Fees Withdrawal", function () {
    beforeEach(async function () {
      await xescrow.connect(provider).registerUser(ROLE_PROVIDER);
      await xescrow.connect(client).registerUser(ROLE_CLIENT);
      await xescrow.connect(provider).createServiceOffer("descHash", ethers.parseEther("1"), 3600);
      await xescrow.connect(client).acceptOffer(0, { value: ethers.parseEther("1") });
      await xescrow.connect(provider).submitProofOfDelivery(0, "proofHash", "comment");
      await xescrow.connect(client).confirmDelivery(0);
    });

    it("Should withdraw fees and emit event", async function () {
      await expect(xescrow.connect(owner).withdrawPlatformFees(owner.address))
        .to.emit(xescrow, "PlatformFeesWithdrawn")
        .withArgs(owner.address, ethers.parseEther("0.02"));
      expect(await xescrow.platformFees()).to.equal(0);
    });

    it("Should reject withdrawal by non-Owner", async function () {
      await expect(xescrow.connect(client).withdrawPlatformFees(client.address)).to.be.revertedWith("Only owner");
    });
  });
});
