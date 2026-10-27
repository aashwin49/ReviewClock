//Stores the live summary of each pull request
const mongoose = require('mongoose');

const pullRqstSchema = new mongoose.Schema(
    {
        sourceId: { type: String, required: true },
        repo: { type: String, required: true },
        prNumber: { type: Number, required: true },
        title: { type: String, required: true },
        author: { type: String, required: true },
        state: { type: String, default: 'open' }, // 'open', 'closed', 'merged'
        reviewStatus: { type: String, default: 'pending' },
        updatedAt: { type: Date, default: Date.now },
        facts: {type: mongoose.Schema.Types.Mixed, default: {}},
        derived: {type: mongoose.Schema.Types.Mixed, default: {}}
    }
);

// Unique compound index so each PR in a repo is tracked as a single document
pullRqstSchema.index({sourceId:1, repo:1, prNumber:1}, {unique:true});

module.exports = mongoose.model('Pull Request', pullRqstSchema);