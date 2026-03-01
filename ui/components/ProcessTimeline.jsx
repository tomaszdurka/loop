export default function ProcessTimeline() {
  const steps = [
    {
      number: "01",
      title: "Bezpłatna konsultacja",
      description: "Skontaktuj się z nami. Nasi eksperci przeanalizują Twoją umowę kredytową i ocenią szanse powodzenia.",
      duration: "24h"
    },
    {
      number: "02",
      title: "Analiza prawna",
      description: "Sprawdzamy dokumenty kredytowe pod kątem klauzul abuzywnych i naruszeń prawa bankowego.",
      duration: "3-5 dni"
    },
    {
      number: "03",
      title: "Przygotowanie pozwu",
      description: "Zespół prawników przygotowuje pozew i kompletuje dokumentację procesową.",
      duration: "7-14 dni"
    },
    {
      number: "04",
      title: "Postępowanie sądowe",
      description: "Reprezentujemy Cię w sądzie. Nie musisz się stawiać osobiście na większości rozpraw.",
      duration: "12-24 mies."
    },
    {
      number: "05",
      title: "Wyrok i egzekucja",
      description: "Po uzyskaniu korzystnego wyroku przeprowadzamy egzekucję i rozliczenie z bankiem.",
      duration: "2-6 mies."
    }
  ];

  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-8 top-8 bottom-8 w-0.5 bg-gradient-to-b from-blue-200 via-blue-300 to-blue-200 md:left-12"></div>

      <div className="space-y-12">
        {steps.map((step, index) => (
          <div key={index} className="relative flex gap-6 md:gap-10">
            {/* Step number circle */}
            <div className="relative z-10 flex-shrink-0">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-blue-700 shadow-lg md:h-24 md:w-24">
                <span className="text-2xl font-bold text-white md:text-3xl">{step.number}</span>
              </div>
            </div>

            {/* Step content */}
            <div className="flex-1 pb-2 pt-2">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition-shadow md:p-8">
                <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                  <h3 className="text-xl font-bold text-slate-900 md:text-2xl">{step.title}</h3>
                  <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700">
                    {step.duration}
                  </span>
                </div>
                <p className="text-slate-600 leading-relaxed">{step.description}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
