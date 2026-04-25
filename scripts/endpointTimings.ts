
import http, { OutgoingHttpHeaders } from 'http';
import https from 'https';
const NETWORK = process.env.NETWORK ?? 'preview';

const apiRequest = async (url: string, accept = 'application/json', method = 'GET', body = '' ): Promise<{ statusCode?: number; body?: string; error?: string, headers?: OutgoingHttpHeaders }> => {
    const client = url.startsWith('http:') ? http : https;
    return new Promise((resolve, reject) => {
        try {
            const options: https.RequestOptions = {
                method: method,
                headers: { Accept: accept}
            };

            let resBody = '';
            const get_req = client.request(url, options, (res) => {
                res.on('data', (chunk) => { resBody += chunk; });
                res.on('error', (err) => {
                    resolve({
                        statusCode: res.statusCode,
                        error: err.message
                    });
                });
                res.on('end', (chunk: any) => {
                    resolve({
                        statusCode: res.statusCode,
                        body: resBody,
                        headers: res.headers
                    });
                });
            });

            if (method == 'POST')
                get_req.write(body);

            get_req.end();
        }
        catch (error: any) {
            resolve({
                statusCode: 500,
                error: error.message
            });
        }
    });
};

const addrList = ["addr1qy0vj5ktefac7mtsdrg7flef7yqhlrw8d60e86c78fctv7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspph4a7",
"addr1qya8chmtzh78hu4xplq7dcteuf3eqcc50j2qmkd69unj4uwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls7ktfpq",
"addr1q9vzs7jkny0vu4rungykar98556jl9yr9c7ad8xuqcf3ewkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspgl2rr",
"addr1q87m0xpl3yvgsgyfjrrk6w6y3k4c8mh8483hcwg47u4yrd7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsvtnux3",
"addr1q9rzqughulxfw2p67taxcxqy8wtve2w9434r8f0g337vtzwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plskww05s",
"addr1q9f4mxexmp8lct9udxnsue36q4eq2p2xwy9y6lm4kdkmkr7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plshudktm",
"addr1q8nymseshgcnc5dyl9u3c5artrtqq8lfgh3supfcnjk0dvwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls2v8skf",
"addr1qx42llvv5p374p9wlty3mrtv7df907gadgjmk3xcpj4ju5kz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsfyckft",
"addr1qy7kvqfxyyhdqekk4y2d6a5fplq6h326uyq68ccnh8xxa4wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plseetdzq",
"addr1q8axalyhqs0y2w3ht9yteqpt2naqnuf04vntt6f3ssykqvwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsm2jezg",
"addr1qx5pqdfzajxhyz9fjt87jk685l4mq39v48atsdsdv66wwqxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plss6y69e",
"addr1qxkh8rrxau9m3wj644cafktmfu3qqjs06n67jfethg9cm3kz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls95hhy6",
"addr1q889gdsy5vhhvdzzyjw2zx4tn5wfk6jxnutv0d8qe4v3dpkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plswn8aw3",
"addr1qxf2v4suugy7a8p8h0gzc7een0h6uw72fee3qmsh2q6h8xxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsczuj6t",
"addr1q9kd8226pzpt03uhc8jkpx4zv8486vtyw4w85vv3xxgmd5xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls5etesf",
"addr1qxu0nf84c5xjff74pq0wd8t6lvtzr6vqr2938m7sjkepel7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsa5820r",
"addr1qyqham292gypmlc093d6ty3udkv6gx8veqk4w77nypsuee7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plstk9zp9",
"addr1q9e6qvmkfyhlah872w6fj6ke32yzmt8zqvn7x95ajwhvq6wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsunjprf",
"addr1qxt2dzq2r4v0l75gryxuku0l7ss8htsz6k5fyketd6cnuy7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plslns0jg",
"addr1q86etwhw35ts3l3vst2d73w4gzarvqvxyegzge4dfwn7qcxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls8c59hl",
"addr1q8uwvjgyn8tke74xguef4u2jcul6samv2sa8mgkccwh890xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsa2cjaa",
"addr1q9atyt66maacz98ar2lmck0gurmnstgxsyja5rk5vyz50rkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsnyxdlz",
"addr1q8ufe7p0z8vjgp4gpfk7qmtpcrm06adlh7gs4acf4vzstuwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsua9nmh",
"addr1qy7ujl26ap0wy3gske7ndjggggh4s20dpzvzw9hvgs9gtq7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsqulptp",
"addr1qxg8kccwvd9nh08e8c7vsyf64966pxrm8ews5a255fwlyl7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls8dxgk4",
"addr1q8k7qd6vg6j3j77hsgghu3j34y64ychljds4shll2hwvc8xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsq3gllu",
"addr1q99pxlvtscc70fw86uhcn7uh89hj58ht05mepgw2ux47n8kz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plswk0e76",
"addr1q9l5s0mmld07rkydpnwnr5rzymk4ddd2qdg64674m84p5pkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls3p2mc0",
"addr1qyrezpmxhptpe7v8jy2uy22ddcmej99ymwclysketfht4hkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls670qfd",
"addr1qx0cns6yngmlt78l0ualgzl5tflwy7j2tptjww62hdth2pxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsk9dy6p",
"addr1qy7jca07mkc77rdwza5qq6eftymjetdyazkeu328c5tppgwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspky0x9",
"addr1qyd5q9jp5x6p57vyuamypfphnuhfsezpu6k6fmj7lqy3flwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plshqf7sm",
"addr1qx859xw4cuvn7pdk7t98m574d53krkfv9culnvpl9lhxyc7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsqx628e",
"addr1q9x2x39fy8uxu3n2l9nkh6afx0hzwm6fv6r3nkcagqjjyf7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plskc42un",
"addr1qxwta2j9w7eyastnpjslc758a75zee7eq59lcrfy66wqwaxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plss3a8cu",
"addr1q9dl5vh7vjwynl7le7p8ryt6ugzqtsucgdyjgehcm52medwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsg88fmm",
"addr1qy4nqe2kzks09he20kz4em225lkllrtx9vahv2cdm83cwuwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsv44s3t",
"addr1qyajdjphtj5jl0l5ctaw3uacxg0aavrc3ntupsy7v6tda87z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsjmfdru",
"addr1qxwmvhssra8mcxd99laq724t5jg6dxesutfgendq3ap3gyxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsyeagca",
"addr1qx9a06x2cpv4ls0wa5kkl43ds6maxaxq053uvclx7q92a57z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls9k704c",
"addr1qy4xkzqdazqsgvq20vzqxmftuxmzu5qtefhdwu0uyjy879wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsts9l8r",
"addr1qytkd94es5g2haztjdrcu26dna3tcyd4eeyz8052gud79nwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsla9w8j",
"addr1qx2hmsq46nyyfk6uvrgkmw56c29pxqsl7yczulukqqs0cswz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsaguxp7",
"addr1q859gzp2fyjfsesj788lmky338c4cz5dwgtywjgue73zu5xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls5tje9p",
"addr1q9tu4hcpfza342tte9rrwkaqevcacw2um6ux9k9t376wtnkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsqe8ah8",
"addr1q8z2ywqu8lkk28aumqkj7gklsh6y9f38xhatsehxh08gfwxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsgnxxzg",
"addr1qy26v8jxtns4d375g4tcje90vcr77u068r7frq78acfh7fkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls777y4c",
"addr1qymfxhpsmvpapamlff2qg3077yv9v5wjdw07stzq2ht5v9xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls4v4emd",
"addr1q986c2lmmvv9d7nc4nux2gp7nvdlhctkf664d3xc7307rp7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls3ka468",
"addr1qxlyd9x77nj9y5rkpj7anl9uhvax3l4ssulgt6c3g7x8x4xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls8kxdk5",
"addr1qx2yc7dpdnx405csldzwtu6ghjelsmzm9t6xpq99lssrsl7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsrq7p7w",
"addr1qyw9c0583kkeaeccdahdt204csv0tsza8ppkrd0admlc03wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plszzaf5x",
"addr1qxezhagxa7gd3e625spcfq252wv0w39tdm9qc3qt5nunaswz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsuctldj",
"addr1q8r7j40n08d9w9jlktered6nytrxzu5tx6vnuedrezha9pwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plswuupt6",
"addr1qytgdvwxj4wpd5dw9wcxy5849lpa3kneke502qglaymc5tkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsdxyh56",
"addr1qxz3ssr467us7lxxtw3l0wuwvg038nsya8h3xq84wgs66hwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsnaw4ul",
"addr1qxflcgm502alg2tvwfqupyzn948h9dg72205cha2hz0cfh7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspv48rl",
"addr1q8v2uwu3z6smzqeuzwyjlqmdr4z35tytl4lun6373pdc9jxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsl3qgw4",
"addr1qye3knuf89s28hp3aeq2aej47s3ww7ey6wpj3cx0p6ndg7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls0sur68",
"addr1qxzyd666hhhe993pa2caaunrxqgvt9k7ckuzw3cujqzvqsxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsgq0km2",
"addr1qx8jfy3g9x0pqmg3lqq38y7vf6tcpuhehf9hzrd55gk5r7kz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plskc74qs",
"addr1qykwf32vz6xt46zduqqdncsdwr3dnrwlq38cn0lpsn2adxkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsnkte2w",
"addr1qyvgzmnyx24ehxdt5w50reem9axqe4fhwq86lusv3wgp27xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls2cpgc9",
"addr1qy4ld4llerkzntu3677y9fj8hestqxuec3pr437nq4pqftxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls28f4et",
"addr1qxrlhyf3vg0w5rmn3yyedg9y922npz47y58t2ee7muv8hkxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls0uq5qr",
"addr1q902n5yw7de9dy8avajrxk8gryx5qznsw7jhczyrtgl3sgxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls0n84ua",
"addr1qy7yafpp77nevtywl58flf0d3ghd0mfgnpwtxmfefk3l377z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls2tjzhe",
"addr1qxwuqhejhhh86ftqqrvrf6c7qljsf7487us3xxv4afqsgfwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls4n3nwu",
"addr1qy962kpuqzfmcx2mt803ju3msdvsf8x5yj74dp6gawv64pkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plskxxuf8",
"addr1q8csypl549ax4gm44wn2gzn245ddwws4kqzknn3dpn58p5xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plswt2uhj",
"addr1q8um2w3404hce93z4x0fss0ev2vp3rc6fevcwvq8zc7kjrkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plswqm6s0",
"addr1q8hjgymw3x8js869g5s5xqq600leq7z6wkqkfjsxe9sk97wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plstqxgft",
"addr1q9yykzwdwdcfdyxk5rclmhv5h474srdfmarfe62ke7kfdyxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls26mzdk",
"addr1qyl82xx8436v0vyr78459nl4l5gsagtelaat9zuv85a54r7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsuetuht",
"addr1q90rp8s2s627euk2vamzacq7kwvlzsvhrvzgx5uxcxx7c8wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls02wg0l",
"addr1q9el383f2alfdvaccqzt0skau97v8yfglynpkcapaje0nxxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls22lm92",
"addr1qxju8cz8f0e8tedzmka0pwl5u3prccq84k48h5hv6mmzyzwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls8esqx3",
"addr1qy8ex5eujrd64h5lpd89h2w76lnugyuxx0es3z47ga4cn27z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plslz07gq",
"addr1qxrmy0w7zsvpe5rtfcdd8uqa8qtr07l9zg67kw8ynn403vwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsyp8axx",
"addr1qy4n8rwkrz79grehzdh2md5s2kekz96z6gf55yj9h8du0nwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls0xlkm2",
"addr1qyvkjftdszqpxn7c5kr8swmla4agkjufarm6754gr4wf8axz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsd7vf8w",
"addr1q8nd0gd7tw2c9fv8ztdhsmec479dydl6jh83avm4039ajg7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsdzc6zt",
"addr1qyjxrrp3wwhejumplmfx9u9qgzwukxd4zrpgmysr7ygjgw7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls5m35yq",
"addr1qyg9h3lyxmtvfzcyerqwvws8wgacntpc372f6vmhqpkr447z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsaqhvlf",
"addr1qxvs25fmhplzpn0ugxahwflc0qe7xelvz5ys2cknrakl0k7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsvenuel",
"addr1q9mvk7900uuuhvch7369k3hfg9s5ryux8alaae8tzztn7dwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls7uzrdm",
"addr1qyft9g0eg2lyx3qw08nv9nrvgs6f4q6nlda5jk8mq82lfrxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plstwgxel",
"addr1qy7cv32ushq0ezg9jtyn66d530d6s9x6ju4lhn26xq7j8ukz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plskt424a",
"addr1qxlltehk7vnwah4h0k8968zghluas8q24ecl2v80xh2k56xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls05q60v",
"addr1q9pqlgg6hukdwystve09gtefay606kztmdlkdp6e9jksltwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls5yq59y",
"addr1q8srj2sll924k0j37xqzyldrlar2sp5p7h424h6gxcstes7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsdvcnlt",
"addr1q9t3d82fr64dm69ta76pg54rtl7qw4pzrc5my06j4xhthawz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsfq3ff9",
"addr1q98wyq4ksul6uqf2j466v25amkgmwnmrrr560a74gjcr6zwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsaeq7mr",
"addr1q8wv48608yx64cpp8zhe7qn5kv3anw72ysevnqwhekey8ykz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls0m87fx",
"addr1qxsh3aft22rwl2a33sulhunl667rlvwg90pqs9m248ptw87z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsjxqdxc",
"addr1q9g9qvx7zrzu6xt9x2xqe9evfct9t2xvscszj4mxjj0cgp7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsj2pdhv",
"addr1q90929hd0j2x995chere4s89848p5luklcz23742kjpp7p7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsnnra6j",
"addr1q96unprg4r22u25z4z6tcus6p44k7elq8y9l3xg9tusq3n7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsa88mur",
"addr1qxuxehr5a5thusc3357smstsr8q8xnvrf5gccqg9j2ukmckz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsd5flw7",
"addr1qxlgwtpnxdxp6ywzq7s2sj3e3lzaq4efzmrvuquxg5anfwwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls4vmn95",
"addr1q9qfs3pe6qt4vycmxqqsw37wk5cyf4r4jrfe0qlxvxw3jtxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsgwqljm",
"addr1q8d4m0zrx283kpezqallvd2ccg0asfv4cd0h784drf2ukqkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsnpjrl7",
"addr1q8azuhmec2whkdewfzr6evw293smd7urd50ua6r5gvm2p5xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plszf7x7x",
"addr1q8cdvpc946mj6sqryedh2ns90q4hw3vu6c86v7wgskqc4kkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsp5d5hh",
"addr1qxks4pddq9y9qlxz3zz05998p9m9s3llwzky83v72jzxyv7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls4udp54",
"addr1qxw56970yg9zkf78j0vrv2n37ywqc0lhrqdph0a9zq4v0uwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspptkyk",
"addr1qxvmhhwwfhtug07hr7luzr3zr88zv36hfxr357eaqu2twt7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls6wwwcu",
"addr1q8wrc3lfaj8ulacacrf20np6mgg2cd2t0t8havewrnvt9mkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls58rxpe",
"addr1q8zdl95mv4xeg9vdn9pkf5ufquqr3fjfzfhe8rakfjd8akxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsrk6evn",
"addr1qyas83ztxuav8d49nqpy6v7d572yqu4y88wc7adnlg947m7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsdad5f2",
"addr1q9k2fv6u7k5u5nv0n8un5unhxv9q3srarhgzlsaz7ys8wj7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls3dzdwm",
"addr1qyvtta6uwajupy3gf8xzzluud6ju3yce5t34ah2m5s8pdckz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls7mvrt7",
"addr1q8x934he35lrt5rxmhzp8cz54n2ll4d97twncjnhkkqlf4wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsha9w8y",
"addr1q8e7uu59l967qqfz9j86qed3ngegjw8ahqcfewdrtu4lc77z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plss7fmrk",
"addr1qyvfe2a3jdteck6e2vfxnw6gjr8p5ph8cxvdyfvrlzh4hcwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsw7rcgh",
"addr1qyjrgzvl9cvs80dt0gpy3mpmgjdy2kn2ea4trxspzfqt9dwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsl2s5uw",
"addr1qx95r3yucv3sedldtkg3d4amrp9xvrctdxegjy7flyvvhakz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plslg5hdq",
"addr1q8u5lcpsrsv9pxh7p0kl66urletasw9dkfmvrgdm4xu5447z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plshynl29",
"addr1qxfjxhypmrx2yvt2tjrhjlr94lyvzxs92t8hln52640nc6xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsw4u4pa",
"addr1qxqyyu3fdcmcm4qq3jqj8hr2ndvccdtqttj5ram456yzfpwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsldde49",
"addr1qxjtvk8g0uhnhnr5anfqgaddnljd92rasfuw3kt2u3sq5dxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsrdhcyz",
"addr1q8zeg62c87u2xg52e3rzgl44tr3whe2jq3yzmqcmz77hc9xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsk4g46g",
"addr1qy57f9p577y9uw3u7v7uyy8xwm7dn2v74pyxrp0lletkuywz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls69e9zn",
"addr1qxtpgqc67jk8wpczu5q86rxvxmnvyz5c9mnpu9vljpr4a4kz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsadvrcc",
"addr1qyx3xld7fhnxyrrzfvgpv8rwv53mj4svnfrpll7rhqu9t7kz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plskfd4v2",
"addr1qy0c0334ghha5es6hxv4zg0tenyucrguqdl7z6l5lmj9rykz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls3gv888",
"addr1q8a7j256d3ztf55eykkcavfgxhmzeqs44gushn70vuz4q6xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls5alf8k",
"addr1q9sg3jfsqetgh5ch08jvd9llztz02unks7qntmhuvlhtlpkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls4z96we",
"addr1qyvr30uxts5kwzhkctqfy0c33v53m6ddhq2ltsd2wwu4szkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsceq0ap",
"addr1qx3rs5csh4g3z3yd42h2v8g54y9c6lgrx26m0ytp4m2h0fwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls39g8y4",
"addr1qx5l8s2stdyg8fr6aspdl050wjestpjnzxp95t9f74cu8swz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plssgad9p",
"addr1qxafy5qxfx2p50w4ewjtr96cfpl3pmt5vx9n777zqahlpfxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls4wtxrs",
"addr1q9pqwl5lzhh0xpvnqcsc4gh2jj3hmkj860mhs7mhp3d9a67z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plstxnysa",
"addr1qxqyx6akazr2ayhv9vvj779n66y2ef94gk0rw8yx6asxjy7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls4cqpzz",
"addr1qywhru2dpf0zmdcrxq26dvwdkr4g87nwr4yuxadfj7hudvkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsl6r6h9",
"addr1qx24vverxwul2cdxs7p86zr9dvjk4y3l89xr07qzaghrqt7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsyzyf3x",
"addr1q8frxsydzcumtzuwq3m73pqqy0fe5822jaj9y3uc3hmpga7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plssu3wtd",
"addr1q8y29lxrpx0mwzzmvfadhmqxqem05tlrjd3hrm74gphyk0wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plslxmnqg",
"addr1qx2syfl0tjmq0lw7de8554229wa5ukfefc5tjs5ewnr3az7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls0t86yw",
"addr1q8zygwqnazccecv0wheuulxf8207fwnuwfzuyfww4t24fnkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsrr7eaq",
"addr1qy23vmg0ydwx4mrpsdhsnevltr4c8lz6f974g54qndrnwaxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsr68sck",
"addr1q8hmwrnqwnvv26artqf64dt3xt60ewwfr4a0cfyzr3qdu4kz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls5a2kah",
"addr1q9pm49xp6yd3ulgcaeqtfdndy4g5umy2f3m7dfn7yztngx7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsd7n2w0",
"addr1q8vnqlf4kmq9ek7mgtt7j6r4tdrmlt6yd23z3slc74sty07z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsxjq4qc",
"addr1qxwrp3led9r2veduzjvkjaaaq5wfn5yp3jt660ryugd02wxz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plssm7eqw",
"addr1qyyg9evl4077dg3axvpkgzw62lhhn09qv8ynq24lsvvhyn7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspmwrc0",
"addr1q8xwesluaay32ehrrajgdty4d8e9sx9pxlhktgaxw4hgxqwz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsqtva8u",
"addr1qxnf9sj9kxxv8dqf929gfjus4dl5qhpqvc5egkq4dthqupkz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls7sju4t",
"addr1q9s2qlzq3h3y6mg8jnfs3f663wtcrg5vjpr5g2w2t6c554wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsqdwt2q",
"addr1qx7x4vuf82sjasy04l4v7ew6axkhez6pvd34l0lexkm5y07z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls94a6ww",
"addr1qxmz3g89adz4vgf9ss2p0s5g0fpuy9kcyh4lygv4y4zzw9xz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsjxyx2k",
"addr1q939jlu96za24vqa0mtunurs0fp3xlaa5f6fg8ar9upepw7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plsf7nkh9",
"addr1zy56r9qkzf4a0lf37d02whylujhg6amqtl72uvwuy8vwdn7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls03prn8",
"addr1zyts3x2ygau0gu20et8fd8pzpvmc8qa0vvd7hd64tykwgm7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622pls3gttxm",
"addr1z8ax5k9mutg07p2ngscu3chsauktmstq92z9de938j8nqa7z28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plssxvmpj"];

(async () => {
    const startTime = Date.now();
    for (let i=0; i<1; i++) {
        apiRequest(`http://localhost:3141/health`).then(() => {console.log(`health: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/holders`).then(() => {console.log(`holders: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/holders/stake1u8p9rks9ql9vl6q5dh9hu55vd9drtqjtc8gqtzqtyd99qlcps0kly`).then(() => {console.log(`holders/:address: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/stats`).then(() => {console.log(`stats: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/handles/papagoose`).then(() => {console.log(`handles/:handle: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/handles/papagoose/utxo`).then(() => {console.log(`handles/:handle/utxo: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/handles/gm/subhandles`).then(() => {console.log(`handles/:handle/subhandles: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/handles/gm/subhandle-settings`).then(() => {console.log(`handles/:handle/subhandle-settings: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/handles/gm/subhandle-settings/utxo`).then(() => {console.log(`handles/:handle/subhandle-settings/utxo: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/handles/papagoose/personalized`).then(() => {console.log(`handles/:handle/personalized: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/handles/papagoose/personalized/utxo`).then(() => {console.log(`handles/:handle/personalized/utxo: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/handles?records_per_page=1000&page=1`).then(() => {console.log(`handles: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/handles/list`, 'application/json', 'POST', JSON.stringify(addrList)).then(() => {console.log(`handles/list: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/handles`, 'text/plain').then(() => {console.log(`ALL handles: ${Date.now() - startTime}`)})
        apiRequest(`http://localhost:3141/scripts?latest=true&type=demi_orders`, 'text/plain').then(() => {console.log(`scripts: ${Date.now() - startTime}`)})
    }
})()