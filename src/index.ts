interface Env {
  YOUTUBE_API_KEY: string;
  SEARCH_QUERY: string;
  MAX_RESULTS: string;
  SEEN_VIDEOS: KVNamespace;
  SLACK_WEBHOOK_URL: string;
  NEWNESS_WINDOW_HOURS: string;
}

interface YouTubeVideo {
  id: {
    videoId: string;
  };
  snippet: {
    title: string;
    publishedAt: string;
    channelTitle: string;
  };
}

interface YouTubeResponse {
  items: YouTubeVideo[];
}

interface SlackMessage {
  text: string;
  blocks?: Array<{
    type: string;
    text?: {
      type: string;
      text: string;
    };
    elements?: Array<{
      type: string;
      text?: {
        type: string;
        text: string;
        emoji?: boolean;
      };
      url?: string;
    }>;
  }>;
}

interface ExecutionResult {
  status: 'success' | 'error';
  message: string;
  details?: any;
}

type VideoCategory = '✨ Brand New' | '📈 Newly Popular';

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Starting scheduled YouTube search...');
    await searchYouTube(env);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log('Received request:', request.method);
    
    if (request.method === 'DELETE') {
      try {
        await env.SEEN_VIDEOS.delete('seen_videos');
        return new Response(JSON.stringify({
          status: 'success',
          message: 'KV storage cleared successfully'
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          status: 'error',
          message: 'Failed to clear KV storage',
          details: error instanceof Error ? error.message : String(error)
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
    }

    if (request.method === 'POST') {
      console.log('Starting manual YouTube search...');
      try {
        const result = await searchYouTube(env);
        return new Response(JSON.stringify({
          status: 'success',
          message: 'Search completed successfully',
          details: result
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          status: 'error',
          message: 'Search failed',
          details: error instanceof Error ? error.message : String(error)
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
    }
    return new Response(JSON.stringify({
      status: 'error',
      message: 'Method not allowed'
    }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
};

async function searchYouTube(env: Env): Promise<{ videosFound: number; newVideos: number; popularVideos: number }> {
  try {
    console.log('Building YouTube API URL...');
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.append('part', 'snippet');
    url.searchParams.append('q', env.SEARCH_QUERY);
    url.searchParams.append('type', 'video');
    url.searchParams.append('order', 'date');
    url.searchParams.append('maxResults', env.MAX_RESULTS);
    url.searchParams.append('key', env.YOUTUBE_API_KEY);

    console.log('Fetching from YouTube API...');
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`YouTube API error: ${response.status} ${response.statusText}`);
    }
    
    const data: YouTubeResponse = await response.json();
    console.log(`Found ${data.items.length} videos in API response`);

    const seenVideos = await loadSeenVideoIds(env);
    console.log(`Loaded ${seenVideos.size} seen videos from KV storage`);

    const newVideos = new Set<string>();
    let newVideoCount = 0;
    let popularVideoCount = 0;

    const newnessWindowHours = parseInt(env.NEWNESS_WINDOW_HOURS || '24', 10);
    const now = new Date();
    const newnessThreshold = new Date(now.getTime() - newnessWindowHours * 60 * 60 * 1000);
    console.log(`Newness threshold set to: ${newnessThreshold.toISOString()}`);

    for (const item of data.items) {
      const videoId = item.id.videoId;
      const publishedAt = new Date(item.snippet.publishedAt);

      if (!seenVideos.has(videoId)) {
        const title = item.snippet.title;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const channel = item.snippet.channelTitle;
        let category: VideoCategory;

        if (publishedAt >= newnessThreshold) {
          category = '✨ Brand New';
          newVideoCount++;
          console.log(`Found Brand New video: ${title}`);
        } else {
          category = '📈 Newly Popular';
          popularVideoCount++;
          console.log(`Found Newly Popular video: ${title} (Published: ${publishedAt.toISOString()})`);
        }

        console.log(`Video URL: ${videoUrl}`);
        console.log(`Published: ${publishedAt.toISOString()} by ${channel}`);

        await sendSlackNotification(env, {
          title,
          url: videoUrl,
          channel,
          publishedAt,
          category
        });
        newVideos.add(videoId);
      }
    }

    console.log(`Found ${newVideoCount} Brand New videos`);
    console.log(`Found ${popularVideoCount} Newly Popular videos`);
    if (newVideos.size > 0) {
      await saveSeenVideoIds(env, new Set([...seenVideos, ...newVideos]));
      console.log(`Saved ${newVideos.size} new video IDs to KV`);
    }
    console.log('Search completed successfully');

    return {
      videosFound: data.items.length,
      newVideos: newVideoCount,
      popularVideos: popularVideoCount
    };
  } catch (error) {
    console.error('Error in searchYouTube:', error);
    throw error;
  }
}

async function loadSeenVideoIds(env: Env): Promise<Set<string>> {
  try {
    const seenVideos = await env.SEEN_VIDEOS.get('seen_videos');
    return new Set(seenVideos ? JSON.parse(seenVideos) : []);
  } catch (error) {
    console.error('Error loading seen videos:', error);
    return new Set();
  }
}

async function saveSeenVideoIds(env: Env, videoIds: Set<string>): Promise<void> {
  try {
    await env.SEEN_VIDEOS.put('seen_videos', JSON.stringify([...videoIds]));
  } catch (error) {
    console.error('Error saving seen videos:', error);
    throw error;
  }
}

interface VideoInfo {
  title: string;
  url: string;
  channel: string;
  publishedAt: Date;
  category: VideoCategory;
}

async function sendSlackNotification(env: Env, video: VideoInfo): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.error('Slack webhook URL not configured');
    return;
  }

  const message: SlackMessage = {
    text: `${video.category} RunPod YouTube Video: ${video.title}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${video.category} RunPod YouTube Video*\n*${video.title}*`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📅 Published: ${video.publishedAt.toLocaleDateString()} by ${video.channel}`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Watch Video',
              emoji: true
            },
            url: video.url
          }
        ]
      }
    ]
  };

  try {
    console.log(`Sending Slack notification for ${video.category} video...`);
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Slack API error: ${response.status} ${response.statusText}\n${errorText}`);
    }
    console.log('Slack notification sent successfully');
  } catch (error) {
    console.error('Failed to send Slack notification:', error);
    // Don't re-throw here to allow the main function to continue saving other video IDs
    // Consider adding more robust error handling/retry logic if needed
  }
} 