const Groq = require('groq-sdk');

class SummarizationService {
  constructor() {
    this.summaryPrompt = `You are an expert meeting analyst. Analyze the following meeting transcript and provide a comprehensive summary.

Return your response as a valid JSON object with the following structure:
{
  "title": "A concise, descriptive title for the meeting",
  "sections": [
    {
      "heading": "Section heading",
      "points": [
        {
          "text": "The main point text",
          "references": []
        }
      ]
    }
  ],
  "actionItems": [
    {
      "task": "Description of the task",
      "assignee": "Name of person assigned (if mentioned)",
      "dueDate": "Due date if mentioned",
      "priority": "high/medium/low"
    }
  ]
}

Guidelines:
- Create logical sections based on the meeting content
- Each point should be a complete, standalone statement
- Extract specific, actionable items from the discussion
- Keep bullet points concise but informative
- The title should capture the essence of the meeting
- Return ONLY valid JSON, no markdown or other formatting

Meeting Transcript:
`;
  }

  async generateSummary(transcript, apiKey) {
    if (!apiKey) {
      throw new Error('Groq API key not configured');
    }

    if (!transcript || transcript.trim().length < 20) {
      throw new Error('Transcript too short to summarize');
    }

    console.log('Generating summary with Groq Llama...');

    const groq = new Groq({ apiKey });

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Summary attempt ${attempt}/3...`);

        const response = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: 'You are a meeting analyst. Output ONLY valid JSON with no markdown formatting, no code blocks, no extra text. Just pure JSON.'
            },
            {
              role: 'user',
              content: this.summaryPrompt + transcript
            }
          ],
          temperature: 0.3,
          max_tokens: 4000
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw new Error('No response from Llama');
        }

        console.log('Got response, parsing JSON...');

        // Try to extract JSON from the response
        let jsonStr = content.trim();

        // Remove markdown code blocks if present
        if (jsonStr.startsWith('```json')) {
          jsonStr = jsonStr.slice(7);
        } else if (jsonStr.startsWith('```')) {
          jsonStr = jsonStr.slice(3);
        }
        if (jsonStr.endsWith('```')) {
          jsonStr = jsonStr.slice(0, -3);
        }
        jsonStr = jsonStr.trim();

        // Find JSON object
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }

        const summary = JSON.parse(jsonStr);
        console.log('Summary parsed successfully:', summary.title);
        return this.validateSummary(summary);

      } catch (error) {
        lastError = error;
        console.error(`Summary attempt ${attempt} failed:`, error.message);

        if (error.status === 429) {
          // Rate limited
          await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
        }

        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
        }
      }
    }

    // If JSON parsing failed, create a basic summary
    console.log('Creating fallback summary...');
    return {
      title: 'Meeting Summary',
      sections: [{
        heading: 'Discussion',
        points: [{
          text: 'Meeting transcript was recorded. Summary generation encountered an error.',
          references: []
        }]
      }],
      actionItems: []
    };
  }

  validateSummary(summary) {
    return {
      title: summary.title || 'Untitled Meeting',
      sections: Array.isArray(summary.sections) ? summary.sections.map(section => ({
        heading: section.heading || 'Discussion',
        points: Array.isArray(section.points) ? section.points.map(point => ({
          text: typeof point === 'string' ? point : (point.text || ''),
          references: Array.isArray(point.references) ? point.references : []
        })) : []
      })) : [],
      actionItems: Array.isArray(summary.actionItems) ? summary.actionItems.map(item => ({
        task: item.task || '',
        assignee: item.assignee || null,
        dueDate: item.dueDate || null,
        priority: item.priority || 'medium'
      })) : []
    };
  }
}

module.exports = { SummarizationService };
