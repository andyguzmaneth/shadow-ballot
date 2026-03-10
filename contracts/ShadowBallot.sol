// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ShadowBallot {
    struct Proposal {
        string title;
        uint256 deadline;
        uint256 yesVotes;
        uint256 noVotes;
        uint256 abstainVotes;
        bool finalized;
    }

    address public immutable coordinator;
    Proposal[] public proposals;

    event ProposalCreated(uint256 indexed proposalId, string title, uint256 deadline);
    event ResultsSubmitted(uint256 indexed proposalId, uint256 yes, uint256 no, uint256 abstain);

    modifier onlyCoordinator() {
        require(msg.sender == coordinator, "Only coordinator");
        _;
    }

    constructor() {
        coordinator = msg.sender;
    }

    function createProposal(string calldata title, uint256 deadline) external onlyCoordinator returns (uint256) {
        uint256 proposalId = proposals.length;
        proposals.push(Proposal({
            title: title,
            deadline: deadline,
            yesVotes: 0,
            noVotes: 0,
            abstainVotes: 0,
            finalized: false
        }));
        emit ProposalCreated(proposalId, title, deadline);
        return proposalId;
    }

    function submitResults(
        uint256 proposalId,
        uint256 yesVotes,
        uint256 noVotes,
        uint256 abstainVotes
    ) external onlyCoordinator {
        require(proposalId < proposals.length, "Invalid proposal");
        Proposal storage p = proposals[proposalId];
        p.yesVotes = yesVotes;
        p.noVotes = noVotes;
        p.abstainVotes = abstainVotes;
        p.finalized = true;
        emit ResultsSubmitted(proposalId, yesVotes, noVotes, abstainVotes);
    }

    function getProposal(uint256 proposalId) external view returns (
        string memory title,
        uint256 deadline,
        uint256 yesVotes,
        uint256 noVotes,
        uint256 abstainVotes,
        bool finalized
    ) {
        require(proposalId < proposals.length, "Invalid proposal");
        Proposal storage p = proposals[proposalId];
        return (p.title, p.deadline, p.yesVotes, p.noVotes, p.abstainVotes, p.finalized);
    }

    function getProposalCount() external view returns (uint256) {
        return proposals.length;
    }
}
