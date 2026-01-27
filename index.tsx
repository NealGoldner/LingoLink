
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, LiveServerMessage, Modality, Blob, Type } from '@google/genai';

// --- 类型定义 ---
interface Message {
  id: string;
  role: 'user' | 'ai';
  text: string;
  translation?: string;
  isTranslating?: boolean;
}

declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  var aistudio: AIStudio;
}

// --- 常量配置 ---
const LIVE_MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TRANSLATION_MODEL_NAME = 'gemini-3-flash-preview'; 

// --- 辅助函数 ---
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'ai',
      text: "Yooo! It's Vibe in the house! 🎤 Ready to drop some knowledge or just debate why cereal is technically a soup? What's the move today, my friend?"
    }
  ]);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [globalBilingual, setGlobalBilingual] = useState(false);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [statusText, setStatusText] = useState('准备就绪');
  const [errorText, setErrorText] = useState<React.ReactNode | null>(null);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  const currentInputText = useRef('');
  const currentOutputText = useRef('');
  const audioBufferQueue = useRef<Blob[]>([]);
  
  // 使用 Ref 追踪双语开关状态，解决 Live API 回调闭包过时的问题
  const globalBilingualRef = useRef(globalBilingual);
  useEffect(() => {
    globalBilingualRef.current = globalBilingual;
    
    // 如果开启了双语模式，检查历史消息并翻译
    if (globalBilingual) {
      messages.forEach(msg => {
        if (msg.role === 'ai' && !msg.translation && !msg.isTranslating) {
          handleTranslate(msg.id, msg.text);
        }
      });
    }
  }, [globalBilingual]);

  useEffect(() => {
    const handleOnline = () => { setIsOnline(true); setErrorText(null); };
    const handleOffline = () => { setIsOnline(false); setErrorText('网络已断开'); if (isSessionActive) stopSession(); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [isSessionActive]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  useEffect(() => {
    const checkStatus = setInterval(() => {
      const active = sourcesRef.current.size > 0;
      if (active !== isAISpeaking) setIsAISpeaking(active);
    }, 100);
    return () => clearInterval(checkStatus);
  }, [isAISpeaking]);

  const checkApiKey = async () => {
    if (process.env.API_KEY) return true;
    if (window.aistudio) {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        await window.aistudio.openSelectKey();
        return true; 
      }
      return true;
    }
    return false;
  };

  const handleTranslate = async (id: string, text: string) => {
    const aiKey = process.env.API_KEY;
    if (!aiKey) return;
    
    setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: true } : m));
    try {
      const ai = new GoogleGenAI({ apiKey: aiKey });
      const response = await ai.models.generateContent({
        model: TRANSLATION_MODEL_NAME,
        contents: `Translate to very natural, expressive, and slightly cool Chinese (avoid robotic textbook translations): "${text}"`,
        config: { systemInstruction: "Output ONLY the cool translation.", temperature: 0.1 }
      });
      const result = response.text?.trim();
      setMessages(prev => prev.map(m => m.id === id ? { ...m, translation: result, isTranslating: false } : m));
    } catch (err: any) {
      console.error("Translation failed", err);
      setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: false } : m));
    }
  };

  const startSession = async () => {
    if (isSessionActive || isConnecting) return;

    if (!inputAudioCtxRef.current) inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    if (!outputAudioCtxRef.current) outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    
    await inputAudioCtxRef.current.resume();
    await outputAudioCtxRef.current.resume();

    setIsConnecting(true);
    setErrorText(null);
    setStatusText('正在召唤 Vibe...');

    try {
      const keyReady = await checkApiKey();
      const currentApiKey = process.env.API_KEY;
      if (!currentApiKey) throw new Error("请设置 API 密钥以继续");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: currentApiKey });
      
      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL_NAME,
        callbacks: {
          onopen: () => {
            setIsSessionActive(true);
            setIsConnecting(false);
            setStatusText('正在热聊中');
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob: Blob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
              sessionPromise.then(session => {
                if (sourcesRef.current.size > 0) audioBufferQueue.current.push(pcmBlob);
                else session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
            sessionRef.current = { stop: () => { stream.getTracks().forEach(t => t.stop()); scriptProcessor.disconnect(); source.disconnect(); } };
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const ctx = outputAudioCtxRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
            }
            if (message.serverContent?.inputTranscription) currentInputText.current += message.serverContent.inputTranscription.text || '';
            if (message.serverContent?.outputTranscription) currentOutputText.current += message.serverContent.outputTranscription.text || '';
            if (message.serverContent?.turnComplete) {
              const uText = currentInputText.current.trim();
              const aText = currentOutputText.current.trim();
              if (uText) setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', text: uText }]);
              if (aText) {
                const id = `a-${Date.now()}`;
                setMessages(prev => [...prev, { id, role: 'ai', text: aText }]);
                // 这里使用 Ref 确保即便在长时间通话中也能获取最新的双语开关状态
                if (globalBilingualRef.current) {
                  handleTranslate(id, aText);
                }
              }
              currentInputText.current = ''; currentOutputText.current = '';
            }
          },
          onerror: (err: any) => {
            console.error(err);
            if (err.message?.includes('entity was not found') || err.message?.includes('API_KEY')) {
              setErrorText(<span>API 密钥无效或未开启计费。 <button onClick={() => window.aistudio?.openSelectKey()} className="font-bold underline">重选密钥</button></span>);
            }
            stopSession();
          },
          onclose: () => stopSession()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `You are 'Vibe', a charismatic, witty, and high-energy English coach. 
          Personality: DJ meets best friend. Adventuresome, sassy, 'main character energy'. 
          Speech Style: Contemporary English. Use idioms and slang naturally.
          Engagement: Long, interesting answers. Always follow up with a great question.
          Correction Style: If the user makes a mistake, model the correct version naturally in your next sentence.`,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
    } catch (err: any) {
      setIsConnecting(false);
      setErrorText(err.message || '麦克风权限被拒绝');
    }
  };

  const stopSession = () => {
    if (sessionRef.current) sessionRef.current.stop();
    setIsSessionActive(false);
    setIsConnecting(false);
    setStatusText('下次见！');
  };

  return (
    <div className="flex flex-col h-screen max-w-[1200px] mx-auto relative overflow-hidden font-sans border-x border-[#E1E8E1] shadow-2xl">
      <header className="glass-header px-4 sm:px-12 py-5 flex flex-col gap-4 sticky top-0 z-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 sm:gap-6">
            <div className={`relative w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg transition-all duration-500 ${isSessionActive ? 'bg-[#2D5A27] scale-110 shadow-[#2D5A27]/20 rotate-12' : 'bg-stone-300'}`}>
              <i className="fas fa-bolt text-xl"></i>
              {isSessionActive && <div className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-400 rounded-full border-2 border-white animate-pulse"></div>}
            </div>
            <div className="flex flex-col">
              <h1 className="font-heading font-bold text-xl sm:text-2xl text-[#1A2E1A] tracking-tight">LingoLink</h1>
              <div className="flex items-center gap-2 mt-0.5">
                 <span className={`w-1.5 h-1.5 rounded-full ${isSessionActive ? 'bg-emerald-500 animate-pulse' : 'bg-stone-400'}`}></span>
                 <p className="text-[10px] text-[#5E7A5E] uppercase tracking-widest font-bold leading-none">{statusText}</p>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={() => window.aistudio?.openSelectKey()} 
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${!process.env.API_KEY ? 'bg-rose-50 text-rose-500 border border-rose-200 animate-bounce' : 'bg-white text-[#2D5A27] border border-stone-200 hover:border-[#2D5A27] hover:shadow-md'}`}
              title="API Key"
            >
              <i className="fas fa-key"></i>
            </button>
            <div className="flex items-center bg-white/50 backdrop-blur-sm p-1 rounded-xl border border-stone-200">
               <button 
                 onClick={() => setGlobalBilingual(!globalBilingual)}
                 className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all flex items-center gap-2 ${globalBilingual ? 'bg-[#2D5A27] text-white shadow-sm' : 'text-[#5E7A5E] hover:bg-stone-100'}`}
               >
                 <i className="fas fa-language text-xs"></i>
                 <span>双语通话</span>
               </button>
            </div>
          </div>
        </div>
        
        {errorText && (
          <div className="bg-rose-50 border border-rose-100 text-rose-800 px-4 py-3 rounded-2xl flex items-center gap-3 animate-fadeIn text-xs font-semibold shadow-sm">
            <i className="fas fa-circle-exclamation text-rose-400 text-base"></i>
            <div className="flex-1">{errorText}</div>
            <button onClick={() => setErrorText(null)} className="opacity-40 hover:opacity-100"><i className="fas fa-xmark"></i></button>
          </div>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        <main ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-16 py-10 space-y-8 chat-area-mask no-scrollbar pb-40">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`message-bubble p-5 sm:p-8 rounded-[2rem] ${msg.role === 'user' ? 'user-bubble' : 'ai-bubble'} relative`}>
                {msg.role === 'ai' && (
                  <div className="absolute -top-3 left-6 px-3 py-1 bg-[#2D5A27] text-white text-[9px] font-black uppercase rounded-full shadow-sm tracking-widest">Vibe</div>
                )}
                <p className="text-[15px] sm:text-[17px] leading-relaxed font-medium tracking-tight whitespace-pre-wrap">{msg.text}</p>
                
                {msg.role === 'ai' && !msg.translation && !msg.isTranslating && !globalBilingual && (
                  <button 
                    onClick={() => handleTranslate(msg.id, msg.text)} 
                    className="mt-4 flex items-center gap-2 text-[11px] font-bold text-[#2D5A27] opacity-50 hover:opacity-100 transition-opacity"
                  >
                    <i className="fas fa-wand-magic-sparkles"></i>
                    地道意译
                  </button>
                )}
                
                {(msg.translation || msg.isTranslating) && (
                   <div className="mt-4 pt-4 border-t border-stone-100/50 text-[14px] sm:text-[15px] text-[#5E7A5E] italic leading-snug">
                     {msg.isTranslating ? (
                       <div className="flex items-center gap-2 opacity-60">
                         <div className="loader !w-4 !h-4 !border-2"></div>
                         <span>思考地道表达...</span>
                       </div>
                     ) : msg.translation}
                   </div>
                )}
              </div>
            </div>
          ))}
          
          {isAISpeaking && (
            <div className="ml-8 flex items-center gap-4 p-4 bg-white/60 backdrop-blur rounded-full border border-stone-200/50 w-fit animate-fadeIn">
              <div className="voice-wave">
                <span style={{ animationDelay: '0s' }}></span>
                <span style={{ animationDelay: '0.1s' }}></span>
                <span style={{ animationDelay: '0.2s' }}></span>
                <span style={{ animationDelay: '0.3s' }}></span>
                <span style={{ animationDelay: '0.4s' }}></span>
              </div>
              <span className="text-[10px] font-black uppercase tracking-widest text-[#2D5A27]">Vibe Speaking...</span>
            </div>
          )}
        </main>
      </div>

      <footer className="absolute bottom-10 left-0 right-0 flex flex-col items-center justify-center pointer-events-none z-50">
        <div className="relative group">
          {isSessionActive && (
             <>
               <div className="absolute inset-0 bg-[#2D5A27]/20 rounded-full blur-2xl animate-pulse"></div>
               <div className="absolute inset-0 rounded-full border-2 border-[#2D5A27]/20 mic-active-ring pointer-events-none"></div>
             </>
          )}
          
          <button 
            onClick={isSessionActive ? stopSession : startSession} 
            disabled={isConnecting || !isOnline}
            className={`pointer-events-auto w-24 h-24 sm:w-28 sm:h-28 rounded-full flex items-center justify-center text-3xl sm:text-4xl shadow-2xl transition-all duration-500 relative z-10 active:scale-90 group-hover:scale-105 ${
              isSessionActive ? 'bg-[#2D5A27] text-white' : 'bg-white text-[#2D5A27] border-2 border-stone-100'
            }`}
          >
            {isConnecting ? (
              <div className="loader !w-10 !h-10 !border-[4px]"></div>
            ) : (
              <i className={`fas ${isSessionActive ? 'fa-microphone' : 'fa-microphone-slash opacity-40'} transition-transform duration-500 ${isSessionActive ? 'scale-110' : ''}`}></i>
            )}
          </button>
        </div>
        
        <p className={`mt-6 text-[10px] font-black uppercase tracking-[0.3em] transition-all duration-700 ${isSessionActive ? 'opacity-40 translate-y-0' : 'opacity-0 translate-y-4'}`}>
          Say something, keep it flowin'
        </p>
      </footer>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
