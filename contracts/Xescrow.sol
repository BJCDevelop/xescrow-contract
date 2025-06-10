// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Xescrow
 * @author Braulio Chavez - Diego Raúl Barrionuevo
 * @notice A decentralized escrow contract for services between Clients and Providers, 
 * with a jury-based dispute resolution system.
 * @dev All technical details of Xescrow
 */

contract Xescrow is ReentrancyGuard {
enum Role { None, Client, Provider, Jurado }
enum OfferStatus { Open, Accepted, Completed, Cancelled, Disputed, Resolved }

/// @notice Stores the role and registration status of a user.
struct User {
Role role;
bool registered;
}

/// @notice Contains all details related to a service offer.
struct Offer {
uint256 id;
address provider;
address client;
uint256 price;
string descriptionHash;
OfferStatus status;
uint256 acceptedAt;
uint256 deliveryTimeout;
string deliveryProofHash;
string deliveryComment;
}

/// @notice Contains all data related to a dispute over an offer.
struct Dispute {
bool exists;
mapping(address => address) voteOf;
mapping(address => bool) isJuror;
address[] jurors;
uint256 votesClient;
uint256 votesProvider;
address winner;
bool resolved;
}

/// @notice The address of the contract owner with administrative privileges.
address public owner;
/// @notice A counter to generate unique IDs for new offers.
uint256 public offerCounter;
/// @notice Percentage fee the platform charges on completed transactions (e.g., 2 = 2%).
uint256 public platformFeePercent = 2;
/// @notice Percentage of the offer price allocated to reward jurors in a dispute (e.g., 10 = 10%).
uint256 public jurorRewardPercent = 10;
/// @notice Total accumulated fees owed to the platform owner.
uint256 public platformFees;

mapping(address => User) public users;
mapping(uint256 => Offer) public offers;
mapping(uint256 => Dispute) private disputes;
mapping(address => uint256[]) public userOffers;
mapping(address => uint256) public pendingWithdrawals;

event UserRegistered(address indexed user, Role role);
event OfferCreated(uint256 indexed offerId, address indexed provider, uint256 price, string descriptionHash);
event OfferAccepted(uint256 indexed offerId, address indexed client);
event DeliveryConfirmed(uint256 indexed offerId);
event ProofSubmitted(uint256 indexed offerId, string proofHash, string comment);
event OfferDisputed(uint256 indexed offerId);
event OfferCancelled(uint256 indexed offerId);
event FundsWithdrawn(address indexed user, uint256 amount);
event PlatformFeesWithdrawn(address indexed owner, uint256 amount);
event VoteCast(uint256 indexed offerId, address indexed juror, address votedFor);
event DisputeResolved(uint256 indexed offerId, address winner);

/// @dev Ensures the function caller is a registered user.
modifier onlyRegistered() {
require(users[msg.sender].registered, "Not registered");
_;
}

/// @dev Restricts function access to the contract owner only.
modifier onlyOwner() {
require(msg.sender == owner, "Only owner");
_;
}

/// @dev Restricts function access to users with the Juror role.
modifier onlyJuror() {
require(users[msg.sender].role == Role.Jurado, "Only jurors");
_;
}

/// @dev Ensures the caller is either the Client or the Provider of a specific offer.
modifier onlyParticipant(uint256 offerId) {
Offer storage offer = offers[offerId];
require(msg.sender == offer.client || msg.sender == offer.provider, "Not participant");
_;
}

/**
 * @notice Initializes the contract, setting the deployer as the owner.
 */
constructor() {
owner = msg.sender;
}

/**
* @notice Allows a user to register on the platform with a specific role.
* @dev The caller cannot be a contract. A user can only register once.
* @param role The role to be assigned (Client, Provider, or Juror).
*/
function registerUser(Role role) external {
require(tx.origin == msg.sender, "Contracts not allowed");
require(!users[msg.sender].registered, "Already registered");
require(role != Role.None, "Invalid role");
users[msg.sender] = User({ role: role, registered: true });
emit UserRegistered(msg.sender, role);
}

/**
* @notice Allows a registered Provider to create a new service offer.
* @param descriptionHash A hash of the service description (e.g., IPFS hash).
* @param price The price of the service in wei.
* @param deliveryTimeout The delivery timeframe in seconds after the offer is accepted.
*/
function createServiceOffer(string memory descriptionHash, uint256 price, uint256 deliveryTimeout) external onlyRegistered {
require(users[msg.sender].role == Role.Provider, "Only providers");
require(price > 0, "Price must be > 0");

offers[offerCounter] = Offer({
id: offerCounter,
provider: msg.sender,
client: address(0),
price: price,
descriptionHash: descriptionHash,
status: OfferStatus.Open,
acceptedAt: 0,
deliveryTimeout: deliveryTimeout,
deliveryProofHash: "",
deliveryComment: ""
});

userOffers[msg.sender].push(offerCounter);
emit OfferCreated(offerCounter, msg.sender, price, descriptionHash);
offerCounter++;
}

/**
* @notice Allows a registered Client to accept an open offer by sending the required payment.
* @dev The offer must be in 'Open' status and the sent value must exactly match the price.
* @param offerId The ID of the offer to accept.
*/
function acceptOffer(uint256 offerId) external payable onlyRegistered nonReentrant {
Offer storage offer = offers[offerId];
require(users[msg.sender].role == Role.Client, "Only clients");
require(offer.status == OfferStatus.Open, "Offer not open");
require(offer.client == address(0), "Already accepted");
require(msg.value == offer.price, "Incorrect payment");

offer.client = msg.sender;
offer.status = OfferStatus.Accepted;
offer.acceptedAt = block.timestamp;
userOffers[msg.sender].push(offerId);
emit OfferAccepted(offerId, msg.sender);
}

/**
* @notice Allows the Provider to submit proof of delivery for an accepted offer.
* @param offerId The ID of the offer.
* @param proofHash A hash of the delivery proof (e.g., a link to a file).
* @param comment A comment to accompany the proof.
*/
function submitProofOfDelivery(uint256 offerId, string memory proofHash, string memory comment) external onlyRegistered {
Offer storage offer = offers[offerId];
require(offer.status == OfferStatus.Accepted, "Offer not accepted");
require(msg.sender == offer.provider, "Only provider");
require(bytes(proofHash).length > 0, "Proof required");

offer.deliveryProofHash = proofHash;
offer.deliveryComment = comment;
emit ProofSubmitted(offerId, proofHash, comment);
}

/**
* @notice Allows the Client to confirm the delivery, completing the transaction and releasing funds to the provider.
* @dev A platform fee is deducted. Can only be called before the delivery timeout expires.
* @param offerId The ID of the offer to confirm.
*/
function confirmDelivery(uint256 offerId) external onlyRegistered nonReentrant {
Offer storage offer = offers[offerId];
require(offer.status == OfferStatus.Accepted, "Offer not accepted");
require(msg.sender == offer.client, "Only client");
require(bytes(offer.deliveryProofHash).length > 0, "No proof submitted");
require(block.timestamp <= offer.acceptedAt + offer.deliveryTimeout, "Delivery timeout");

uint256 platformFee = (offer.price * platformFeePercent) / 100;
pendingWithdrawals[offer.provider] += offer.price - platformFee;
platformFees += platformFee;
offer.status = OfferStatus.Completed;

emit DeliveryConfirmed(offerId);
}

/**
* @notice Allows a participant (Client or Provider) to open a dispute if the delivery timeout has passed.
* @param offerId The ID of the offer to dispute.
*/
function disputeOffer(uint256 offerId) external onlyRegistered onlyParticipant(offerId) {
Offer storage offer = offers[offerId];
require(offer.status == OfferStatus.Accepted, "Not disputable");
require(block.timestamp > offer.acceptedAt + offer.deliveryTimeout, "Too early");
require(!disputes[offerId].exists, "Already disputed");

offer.status = OfferStatus.Disputed;
disputes[offerId].exists = true;
emit OfferDisputed(offerId);
}

/**
* @notice Allows a registered Juror to vote on an active dispute. The dispute is resolved when one party reaches 2 votes.
* @dev Rewards are distributed to the jurors who voted for the winner.
* @param offerId The ID of the disputed offer.
* @param votedFor The address of the participant (Client or Provider) for whom the juror is voting.
*/
function voteDispute(uint256 offerId, address votedFor) external onlyRegistered onlyJuror {
Offer storage offer = offers[offerId];
Dispute storage dispute = disputes[offerId];
require(offer.status == OfferStatus.Disputed, "Not in dispute");
require(!dispute.resolved, "Already resolved");
require(!dispute.isJuror[msg.sender], "Already voted");
require(votedFor == offer.client || votedFor == offer.provider, "Invalid vote");

dispute.voteOf[msg.sender] = votedFor;
dispute.isJuror[msg.sender] = true;
dispute.jurors.push(msg.sender);

if (votedFor == offer.client) {
dispute.votesClient++;
} else {
dispute.votesProvider++;
}

emit VoteCast(offerId, msg.sender, votedFor);

if (dispute.votesClient >= 2 || dispute.votesProvider >= 2) {
address winner = dispute.votesClient >= 2 ? offer.client : offer.provider;
dispute.winner = winner;
dispute.resolved = true;
offer.status = OfferStatus.Resolved;

uint256 platformFee = (offer.price * platformFeePercent) / 100;
uint256 jurorReward = (offer.price * jurorRewardPercent) / 100;
uint256 rewardPerJuror = jurorReward / (winner == offer.client ? dispute.votesClient : dispute.votesProvider);

for (uint256 i = 0; i < dispute.jurors.length; i++) {
if (dispute.voteOf[dispute.jurors[i]] == winner) {
pendingWithdrawals[dispute.jurors[i]] += rewardPerJuror;
}
}

pendingWithdrawals[winner] += offer.price - platformFee - jurorReward;
platformFees += platformFee;

emit DisputeResolved(offerId, winner);
}
}

/**
* @notice Allows a Provider to cancel an offer that has not yet been accepted.
* @param offerId The ID of the offer to cancel.
*/
function cancelOffer(uint256 offerId) external onlyRegistered {
Offer storage offer = offers[offerId];
require(offer.status == OfferStatus.Open, "Cannot cancel");
require(msg.sender == offer.provider, "Only provider");

offer.status = OfferStatus.Cancelled;
emit OfferCancelled(offerId);
}

/**
* @notice Allows any user (Provider, Client, Juror) to withdraw their pending balance.
*/
function withdrawFunds() external nonReentrant {
uint256 amount = pendingWithdrawals[msg.sender];
require(amount > 0, "Nothing to withdraw");
pendingWithdrawals[msg.sender] = 0;

(bool success, ) = msg.sender.call{value: amount}("");
require(success, "Withdraw failed");
emit FundsWithdrawn(msg.sender, amount);
}

/**
* @notice Allows the contract owner to withdraw the accumulated platform fees.
* @param to The address to which the fees will be sent.
*/
function withdrawPlatformFees(address payable to) external onlyOwner nonReentrant {
require(platformFees > 0, "No fees");
uint256 amount = platformFees;
platformFees = 0;

(bool success, ) = to.call{value: amount}("");
require(success, "Transfer failed");
emit PlatformFeesWithdrawn(to, amount);
}

/**
* @notice Returns a list of all offer IDs associated with a user.
* @param user The address of the user.
* @return uint256[] An array of offer IDs.
*/
function getUserOffers(address user) external view returns (uint256[] memory) {
return userOffers[user];
}


/**
* @notice Returns the details of a specific dispute.
* @param offerId The ID of the offer to query dispute details for.
* @return exists True if a dispute exists for this offer.
* @return votesClient The number of votes for the client.
* @return votesProvider The number of votes for the provider.
* @return jurors An array of the jurors' addresses who have voted.
* @return winner The address of the dispute winner, if resolved.
* @return resolved True if the dispute has been resolved.
*/
function getDisputeDetails(uint256 offerId) external view returns (
bool exists,
uint256 votesClient,
uint256 votesProvider,
address[] memory jurors,
address winner,
bool resolved
) {
Dispute storage dispute = disputes[offerId];
return (
dispute.exists,
dispute.votesClient,
dispute.votesProvider,
dispute.jurors,
dispute.winner,
dispute.resolved
);
}


/**
* @dev Fallback function to receive Mantle. Not actively used in the main logic.
*/
receive() external payable {}
}
